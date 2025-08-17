import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Initialize Supabase client with service role key for backend operations
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing Supabase environment variables');
  process.exit(1);
}

// Use service role key for backend operations to bypass RLS
const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

const app = express();
const PORT = process.env.PORT || 3001;

// Rate limiter
const rateLimiter = new RateLimiterMemory({
  keyGenerator: (req) => req.ip,
  points: 10, // 10 requests
  duration: 60, // per 60 seconds
});

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting middleware
const rateLimitMiddleware = async (req, res, next) => {
  try {
    await rateLimiter.consume(req.ip);
    next();
  } catch (rejRes) {
    res.status(429).json({ 
      error: 'Too many requests', 
      message: 'Rate limit exceeded. Please try again later.' 
    });
  }
};

// Auth middleware
const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.split(' ')[1];
    
    // Find user by webhook token
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, full_name, webhook_token')
      .eq('webhook_token', token)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid authorization token' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Real Apify SERP API integration with parallel processing
const callApifySerpApi = async (keyword, apiKey, country = "US", page = 1) => {
  console.log(`🔍 Analyzing keyword: ${keyword} with API key: ${apiKey.substring(0, 8)}...`);
  
  try {
    // Step 1: Start SERP actor asynchronously
    console.log(`📡 Starting Apify SERP API for keyword: ${keyword}`);
    const serpResponse = await fetch('https://api.apify.com/v2/acts/scraperlink~google-search-results-serp-scraper/runs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        "country": country,
        "keyword": keyword,
        "page": page
      })
    });

    if (!serpResponse.ok) {
      const errorText = await serpResponse.text();
      throw new Error(`SERP API failed: ${serpResponse.status} ${serpResponse.statusText}`);
    }

    const serpRunData = await serpResponse.json();
    const runId = serpRunData.data?.id;

    if (!runId) {
      throw new Error('No run ID received from Apify SERP API');
    }

    // Wait for SERP run to complete
    console.log(`⏳ Waiting for SERP run to complete...`);
    let serpAttempts = 0;
    const maxSerpAttempts = 60; // Wait up to 5 minutes

    while (serpAttempts < maxSerpAttempts) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
      serpAttempts++;

      const statusResponse = await fetch(`https://api.apify.com/v2/acts/scraperlink~google-search-results-serp-scraper/runs/${runId}`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      if (!statusResponse.ok) {
        continue;
      }

      const statusData = await statusResponse.json();

      if (statusData.data?.status === 'SUCCEEDED') {
        console.log(`✅ SERP run completed successfully`);
        break;
      } else if (statusData.data?.status === 'FAILED') {
        throw new Error(`SERP run failed: ${statusData.data?.meta?.errorMessage || 'Unknown error'}`);
      }
    }

    if (serpAttempts >= maxSerpAttempts) {
      throw new Error('SERP run timed out after 5 minutes');
    }

    // Get dataset ID from completed run
    const finalStatusResponse = await fetch(`https://api.apify.com/v2/acts/scraperlink~google-search-results-serp-scraper/runs/${runId}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    const finalStatusData = await finalStatusResponse.json();
    const datasetId = finalStatusData.data?.defaultDatasetId;

    if (!datasetId) {
      throw new Error('No dataset ID received from completed Apify SERP run');
    }

    // Wait for dataset to populate
    await new Promise(resolve => setTimeout(resolve, 20000)); // Wait 20 seconds

    // Poll dataset until we have results
    let serpData = null;
    let datasetAttempts = 0;
    const maxDatasetAttempts = 60;

    while (datasetAttempts < maxDatasetAttempts) {
      const serpResultsResponse = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      if (!serpResultsResponse.ok) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        datasetAttempts++;
        continue;
      }

      serpData = await serpResultsResponse.json();

      if (serpData && serpData.length > 0) {
        console.log(`✅ SERP results received: ${serpData.length} items`);
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 5000));
      datasetAttempts++;
    }

    if (!serpData || serpData.length === 0) {
      throw new Error('SERP dataset is empty after 5 minutes of polling');
    }

    // Parse SERP data
    let serpResults = [];
    let searchTerm = '';
    let knowledgePanel = null;
    let relatedKeywords = [];
    
    if (Array.isArray(serpData) && serpData.length > 0) {
      const firstItem = serpData[0];
      serpResults = firstItem.results || [];
      searchTerm = firstItem.search_term || keyword;
      knowledgePanel = firstItem.knowledge_panel || null;
      relatedKeywords = firstItem.related_keywords?.keywords || [];
    } else if (serpData.results && Array.isArray(serpData.results)) {
      serpResults = serpData.results;
      searchTerm = serpData.search_term || keyword;
      knowledgePanel = serpData.knowledge_panel || null;
      relatedKeywords = serpData.related_keywords?.keywords || [];
    } else {
      throw new Error('Unexpected SERP data structure received from Apify');
    }

    // Extract URLs from SERP results
    const urls = serpResults.map(result => result.url).filter(url => url);
    
    if (urls.length === 0) {
      throw new Error('No URLs found in SERP results');
    }

    // Step 2: Start Metrics actor asynchronously
    console.log(`📊 Starting Apify Metrics API for ${urls.length} URLs`);
    
    const metricsResponse = await fetch('https://api.apify.com/v2/acts/scrap3r~moz-da-pa-metrics/runs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        "url": urls
      })
    });

    if (!metricsResponse.ok) {
      const errorText = await metricsResponse.text();
      throw new Error(`Metrics API failed: ${metricsResponse.status} ${metricsResponse.statusText}`);
    }

    const metricsRunData = await metricsResponse.json();
    const metricsRunId = metricsRunData.data?.id;

    if (!metricsRunId) {
      throw new Error('No run ID received from Apify Metrics API');
    }

    // Wait for Metrics run to complete
    console.log(`⏳ Waiting for Metrics run to complete...`);
    let metricsRunAttempts = 0;
    const maxMetricsRunAttempts = 60;

    while (metricsRunAttempts < maxMetricsRunAttempts) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      metricsRunAttempts++;

      const metricsStatusResponse = await fetch(`https://api.apify.com/v2/acts/scrap3r~moz-da-pa-metrics/runs/${metricsRunId}`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      if (!metricsStatusResponse.ok) {
        continue;
      }

      const metricsStatusData = await metricsStatusResponse.json();

      if (metricsStatusData.data?.status === 'SUCCEEDED') {
        console.log(`✅ Metrics run completed successfully`);
        break;
      } else if (metricsStatusData.data?.status === 'FAILED') {
        throw new Error(`Metrics run failed: ${metricsStatusData.data?.meta?.errorMessage || 'Unknown error'}`);
      }
    }

    if (metricsRunAttempts >= maxMetricsRunAttempts) {
      throw new Error('Metrics run timed out after 5 minutes');
    }

    // Get dataset ID from completed run
    const finalMetricsStatusResponse = await fetch(`https://api.apify.com/v2/acts/scrap3r~moz-da-pa-metrics/runs/${metricsRunId}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    const finalMetricsStatusData = await finalMetricsStatusResponse.json();
    const metricsDatasetId = finalMetricsStatusData.data?.defaultDatasetId;

    if (!metricsDatasetId) {
      throw new Error('No dataset ID received from completed Apify Metrics run');
    }

    // Wait for dataset to populate
    await new Promise(resolve => setTimeout(resolve, 20000));

    // Poll dataset until we have results
    let metricsData = null;
    let metricsAttempts = 0;
    const maxMetricsAttempts = 60;

    while (metricsAttempts < maxMetricsAttempts) {
      const metricsResultsResponse = await fetch(`https://api.apify.com/v2/datasets/${metricsDatasetId}/items`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      if (!metricsResultsResponse.ok) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        metricsAttempts++;
        continue;
      }

      metricsData = await metricsResultsResponse.json();

      if (metricsData && metricsData.length > 0) {
        console.log(`✅ Metrics results received: ${metricsData.length} items`);
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 5000));
      metricsAttempts++;
    }

    if (!metricsData || metricsData.length === 0) {
      throw new Error('Metrics dataset is empty after 5 minutes of polling');
    }

    if (!Array.isArray(metricsData)) {
      throw new Error('Invalid metrics data structure received from Apify');
    }

    // Step 3: Combine SERP results with metrics
    const combinedResults = serpResults.map((result, index) => {
      const metrics = metricsData.find(m => m.domain === result.url) || {};
      
      return {
        position: result.position || index + 1,
        url: result.url,
        title: result.title,
        description: result.description,
        domain_authority: metrics.domain_authority || 0,
        page_authority: metrics.page_authority || 0,
        spam_score: metrics.spam_score || 0
      };
    });
    
    console.log(`✅ Combined ${combinedResults.length} results for: ${keyword}`);
    
    return {
      keyword: keyword,
      results: combinedResults,
      serp_features: relatedKeywords,
      knowledge_panel: knowledgePanel
    };

  } catch (error) {
    console.error(`❌ Apify API error for ${keyword}:`, error.message);
    
    if (error.message.includes('401')) {
      throw new Error('Invalid API key - please check your Apify API key');
    } else if (error.message.includes('429')) {
      throw new Error('Rate limit exceeded - API key may be out of credits');
    } else if (error.message.includes('404')) {
      throw new Error('Apify actor not found - please check actor configuration');
    } else {
      throw new Error(`Apify API error: ${error.message}`);
    }
  }
};

// Main SERP analysis endpoint with parallel processing
app.post('/api/analyze-serps', rateLimitMiddleware, authMiddleware, async (req, res) => {
  const startTime = Date.now();
  const requestId = uuidv4();
  
  try {
    console.log(`🚀 Starting SERP analysis request: ${requestId}`);
    console.log(`👤 User: ${req.user.id} (${req.user.email})`);
    
    const { keywords, country = "US", page = 1, write_skip_config = {} } = req.body;
    
    // Set default Write/Skip configuration
    const x = write_skip_config.x || 5;  // Number of low DA domains required
    const y = write_skip_config.y || 10; // Top Y results to check
    const z = write_skip_config.z || 35; // DA threshold (domains below this are "low DA")
    
    console.log(`📊 Write/Skip Config: x=${x}, y=${y}, z=${z}`);
    
    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      console.log(`❌ Invalid request: keywords array is empty or missing`);
      return res.status(400).json({ 
        error: 'Invalid request', 
        message: 'Keywords array is required and must not be empty' 
      });
    }

    if (keywords.length > 30) {
      console.log(`❌ Too many keywords: ${keywords.length} (max 30)`);
      return res.status(400).json({ 
        error: 'Too many keywords', 
        message: 'Maximum 30 keywords allowed per request' 
      });
    }

    console.log(`📊 Processing ${keywords.length} keywords:`, keywords);

    // Log the request
    try {
      const { error: logError } = await supabase.from('analysis_logs').insert({
        user_id: req.user.id,
        request_id: requestId,
        keywords: keywords,
        status: 'pending'
      });

      if (logError) {
        console.error(`❌ Failed to log request:`, logError);
      } else {
        console.log(`✅ Request logged successfully`);
      }
    } catch (logError) {
      console.error(`❌ Error logging request:`, logError);
    }

    // Get user's API keys
    const { data: apiKeys, error: keysError } = await supabase
      .from('api_keys')
      .select('*')
      .eq('user_id', req.user.id)
      .in('status', ['active', 'failed', 'rate_limited'])
      .order('last_used', { ascending: true, nullsFirst: true });

    if (keysError) {
      console.error(`❌ Error fetching API keys:`, keysError);
      await supabase.from('analysis_logs').update({
        status: 'failed',
        error_message: `Database error: ${keysError.message}`,
        processing_time: Date.now() - startTime
      }).eq('request_id', requestId);

      return res.status(500).json({ 
        error: 'Database error', 
        message: 'Failed to fetch API keys' 
      });
    }

    if (!apiKeys || apiKeys.length === 0) {
      console.log(`❌ No API keys found for user ${req.user.id}`);
      await supabase.from('analysis_logs').update({
        status: 'failed',
        error_message: 'No API keys available',
        processing_time: Date.now() - startTime
      }).eq('request_id', requestId);

      return res.status(400).json({ 
        error: 'No API keys', 
        message: 'Please add at least one Apify API key' 
      });
    }

    // Sort keys by priority: active first, then by last_used (oldest first)
    const sortedApiKeys = apiKeys.sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (a.status !== 'active' && b.status === 'active') return 1;
      
      if (!a.last_used && !b.last_used) return 0;
      if (!a.last_used) return -1;
      if (!b.last_used) return 1;
      
      return new Date(a.last_used).getTime() - new Date(b.last_used).getTime();
    });

    console.log(`🔑 Found ${sortedApiKeys.length} API keys for user ${req.user.id}`);

    // 🚀 PARALLEL PROCESSING: Process keywords in batches of 10
    const batchSize = 10;
    const results = [];
    const usedKeys = [];

    for (let i = 0; i < keywords.length; i += batchSize) {
      const batch = keywords.slice(i, i + batchSize);
      console.log(`🔄 Processing batch ${Math.floor(i/batchSize) + 1}: ${batch.length} keywords`);
      
      // Process batch in parallel
      const batchPromises = batch.map(async (keyword, batchIndex) => {
        const keyIndex = (i + batchIndex) % sortedApiKeys.length;
        const currentKey = sortedApiKeys[keyIndex];
        
        console.log(`🔍 Processing keyword: ${keyword} with API key: ${currentKey.key_name}`);
        
        try {
          const serpResult = await callApifySerpApi(keyword, currentKey.api_key, country, page);
          
          // Calculate analysis metrics
          const domains = serpResult.results.map(r => r.url);
          const das = serpResult.results.map(r => r.domain_authority);
          const averageDA = das.reduce((sum, da) => sum + da, 0) / das.length;
          const lowDACount = das.filter(da => da < z).length; // Use z from config
          const decision = lowDACount >= x ? 'Write' : 'Skip'; // Use x and z from config

          const result = {
            keyword,
            api_key_used: currentKey.key_name,
            domains: domains.slice(0, y), // Use y from config
            average_da: Math.round(averageDA),
            low_da_count: lowDACount,
            decision,
            serp_features: serpResult.serp_features || [],
            full_results: serpResult.results,
            write_skip_config_used: { x, y, z }, // Add config used
            detailed_results: serpResult.results.map(r => ({
              domain: r.url,
              da: r.domain_authority || 0,
              spam_score: r.spam_score || 0,
              position: r.position,
              title: r.title,
              description: r.description
            }))
          };
          
          console.log(`✅ Created result for ${keyword}:`, {
            keyword: result.keyword,
            api_key_used: result.api_key_used,
            decision: result.decision,
            average_da: result.average_da,
            results_count: result.full_results.length
          });

          // Reactivate the key
          try {
            await supabase.from('api_keys').update({
              last_used: new Date().toISOString(),
              failure_count: 0,
              status: 'active',
              last_failed: null
            }).eq('id', currentKey.id);
            console.log(`✅ Successfully reactivated API key: ${currentKey.key_name}`);
          } catch (updateError) {
            console.error(`❌ Error reactivating API key ${currentKey.key_name}:`, updateError);
          }

          usedKeys.push(currentKey.id);
          return result;
          
        } catch (error) {
          console.error(`❌ Error with API key ${currentKey.key_name}:`, error.message);
          
          // Enhanced error detection
          const errorMessage = error.message.toLowerCase();
          const isRateLimit = errorMessage.includes('rate') || errorMessage.includes('credit') || errorMessage.includes('429') || errorMessage.includes('quota');
          const isInvalidKey = errorMessage.includes('invalid api key') || errorMessage.includes('401') || errorMessage.includes('unauthorized');
          const isPermanentFailure = errorMessage.includes('not found') || errorMessage.includes('404') || errorMessage.includes('actor not found');
          
          let newStatus = 'failed';
          
          if (isRateLimit) {
            newStatus = 'rate_limited';
            console.log(`⚠️ Rate limit detected for API key: ${currentKey.key_name}`);
          } else if (isInvalidKey || isPermanentFailure) {
            newStatus = 'failed';
            console.log(`❌ Permanent failure detected for API key: ${currentKey.key_name}`);
          } else {
            newStatus = 'failed';
            console.log(`⚠️ Temporary failure detected for API key: ${currentKey.key_name}`);
          }

          // Update key status
          try {
            await supabase.from('api_keys').update({
              status: newStatus,
              last_failed: new Date().toISOString(),
              failure_count: (currentKey.failure_count || 0) + 1
            }).eq('id', currentKey.id);
            console.log(`📝 Updated API key ${currentKey.key_name} status to: ${newStatus}`);
          } catch (updateError) {
            console.error(`❌ Error updating API key status:`, updateError);
          }

          return {
            keyword,
            api_key_used: null,
            error: error.message,
            decision: 'Error',
            detailed_results: []
          };
        }
      });

      // Wait for batch to complete
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      
      console.log(`✅ Batch ${Math.floor(i/batchSize) + 1} completed: ${batchResults.length} results`);
    }

    const processingTime = Date.now() - startTime;
    console.log(`⏱️ Total processing time: ${processingTime}ms`);

    // Update the log with results
    try {
      const { error: updateError } = await supabase.from('analysis_logs').update({
        status: 'completed',
        results: results,
        api_keys_used: usedKeys,
        processing_time: processingTime
      }).eq('request_id', requestId);

      if (updateError) {
        console.error(`❌ Failed to update analysis log:`, updateError);
      } else {
        console.log(`✅ Analysis log updated successfully`);
      }

      // Store detailed SERP results
      try {
        const { data: analysisLog } = await supabase
          .from('analysis_logs')
          .select('id')
          .eq('request_id', requestId)
          .single();

        if (analysisLog) {
          const serpResultsToInsert = [];
          const globalSerpDataToInsert = [];
          
          results.forEach(result => {
            if (result.detailed_results && Array.isArray(result.detailed_results)) {
              result.detailed_results.forEach(detail => {
                // Store in user-specific serp_results table
                serpResultsToInsert.push({
                  analysis_log_id: analysisLog.id,
                  keyword: result.keyword,
                  domain: detail.domain,
                  da: detail.da,
                  spam_score: detail.spam_score,
                  position: detail.position,
                  title: detail.title,
                  description: detail.description,
                  url: detail.url
                });

                // Store in global table (no duplicates)
                globalSerpDataToInsert.push({
                  domain: detail.domain,
                  da: detail.da,
                  spam_score: detail.spam_score
                });
              });
            }
          });

          // Insert user-specific results
          if (serpResultsToInsert.length > 0) {
            const { error: serpError } = await supabase
              .from('serp_results')
              .insert(serpResultsToInsert);

            if (serpError) {
              console.error(`❌ Failed to store detailed SERP results:`, serpError);
            } else {
              console.log(`✅ Stored ${serpResultsToInsert.length} detailed SERP results`);
            }
          }

          // Insert global data (with duplicate prevention)
          if (globalSerpDataToInsert.length > 0) {
            for (const globalData of globalSerpDataToInsert) {
              try {
                const { error: globalError } = await supabase
                  .from('global_serp_data')
                  .upsert({
                    domain: globalData.domain,
                    da: globalData.da,
                    spam_score: globalData.spam_score,
                    scrape_date: new Date().toISOString()
                  }, {
                    onConflict: 'domain',
                    ignoreDuplicates: false
                  });

                if (globalError) {
                  console.error(`❌ Failed to store global SERP data for ${globalData.domain}:`, globalError);
                }
              } catch (globalError) {
                console.error(`❌ Error storing global SERP data for ${globalData.domain}:`, globalError);
              }
            }
            console.log(`✅ Processed ${globalSerpDataToInsert.length} global SERP data entries`);
          }
        }
      } catch (serpError) {
        console.error(`❌ Error storing detailed SERP results:`, serpError);
      }
    } catch (updateError) {
      console.error(`❌ Error updating analysis log:`, updateError);
    }

    const finalResults = results.map(result => {
      const serpResultsText = result.full_results?.map(item => 
        `Position: ${item.position}\n` +
        `Title: ${item.title}\n` +
        `Description: ${item.description}\n` +
        `URL: ${item.url}\n` +
        `DA: ${item.domain_authority}\n` +
        `PA: ${item.page_authority}\n` +
        `Spam Score: ${item.spam_score}\n`
      ).join('\n') || '';

      const relatedKeywordsText = result.serp_features?.map(item => 
        item.keyword
      ).join('\n') || '';

      const domainsText = result.domains?.join('\n') || '';

      return {
        keyword: result.keyword,
        api_key_used: result.api_key_used,
        domains: result.domains || [],
        domains_text: domainsText,
        average_da: result.average_da || 0,
        low_da_count: result.low_da_count || 0,
        decision: result.decision || 'Error',
        serp_features: result.serp_features || [],
        related_keywords_text: relatedKeywordsText,
        full_results: result.full_results || [],
        serp_results_text: serpResultsText,
        detailed_results: result.detailed_results || [],
        error: result.error || null
      };
    });
    
    console.log(`📊 Final response mapping:`, finalResults.map(r => ({
      keyword: r.keyword,
      api_key_used: r.api_key_used,
      decision: r.decision,
      results_count: r.full_results?.length || 0
    })));
    
    res.json({
      request_id: requestId,
      keywords_processed: keywords.length,
      country: country,
      page: page,
      processing_time: processingTime,
      results: finalResults
    });

  } catch (error) {
    console.error('❌ SERP analysis error:', error);
    console.error('❌ Full error stack:', error.stack);
    
    const processingTime = Date.now() - startTime;
    
    // Update log with error
    try {
      await supabase.from('analysis_logs').update({
        status: 'failed',
        error_message: error.message,
        processing_time: processingTime
      }).eq('request_id', requestId);
    } catch (updateError) {
      console.error('❌ Failed to update error log:', updateError);
    }

    res.status(500).json({ 
      error: 'Analysis failed', 
      message: error.message || 'An error occurred during SERP analysis',
      request_id: requestId
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    supabase_connected: !!supabaseUrl
  });
});

// Start server
app.listen(PORT, () => {
  const baseUrl = process.env.VITE_API_BASE_URL || `http://localhost:${PORT}`;
  const isProduction = baseUrl.includes('onrender.com');
  const webhookUrl = isProduction ? `${baseUrl}/api/analyze-serps` : `http://localhost:${PORT}/api/analyze-serps`;
  
  console.log(`🚀 SERP Analysis API server running on port ${PORT}`);
  console.log(`📡 Health check: ${baseUrl}/api/health`);
  console.log(`🔗 Webhook URL: ${webhookUrl}`);
  console.log(`✅ Supabase connected: ${!!supabaseUrl}`);
  console.log(`🌍 Environment: ${isProduction ? 'Production' : 'Development'}`);
});

export default app;
