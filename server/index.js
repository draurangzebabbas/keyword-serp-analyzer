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

// Real Apify SERP API integration - matches your working Make.com flow exactly
const callApifySerpApi = async (keyword, apiKey, country = "US", page = 1) => {
  console.log(`🔍 Analyzing keyword: ${keyword} with API key: ${apiKey.substring(0, 8)}...`);
  console.log(`🔑 API key length: ${apiKey.length}`);
  console.log(`🔑 API key starts with: ${apiKey.substring(0, 10)}...`);
  
  try {
    // Step 1: Start SERP actor asynchronously (like your Make.com flow)
    console.log(`📡 Starting Apify SERP API for keyword: ${keyword}, country: ${country}, page: ${page}`);
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

    console.log(`📊 SERP Response Status: ${serpResponse.status} ${serpResponse.statusText}`);
    console.log(`📊 SERP Response Headers:`, Object.fromEntries(serpResponse.headers.entries()));

    if (!serpResponse.ok) {
      const errorText = await serpResponse.text();
      console.error(`❌ SERP API Error: ${errorText}`);
      throw new Error(`SERP API failed: ${serpResponse.status} ${serpResponse.statusText}`);
    }

    // Get raw response text first
    const serpResponseText = await serpResponse.text();
    console.log(`📊 Raw SERP response length: ${serpResponseText.length}`);
    console.log(`📊 Raw SERP response: ${serpResponseText.substring(0, 1000)}...`);
    
    if (!serpResponseText || serpResponseText.trim() === '') {
      throw new Error('Empty response from Apify SERP API');
    }

    let serpRunData;
    try {
      serpRunData = JSON.parse(serpResponseText);
    } catch (parseError) {
      console.error(`❌ SERP JSON parse error: ${parseError.message}`);
      console.error(`❌ SERP response text: ${serpResponseText}`);
      throw new Error(`Invalid JSON response from Apify SERP: ${parseError.message}`);
    }

    const runId = serpRunData.data?.id;
    console.log(`📊 SERP run ID: ${runId}`);
    console.log(`📊 Full SERP run data:`, JSON.stringify(serpRunData, null, 2));

    if (!runId) {
      console.error(`❌ No run ID found in SERP response:`, serpRunData);
      throw new Error('No run ID received from Apify SERP API');
    }

    // Wait for SERP run to complete
    console.log(`⏳ Waiting for SERP run to complete...`);
    let serpAttempts = 0;
    const maxSerpAttempts = 60; // Wait up to 5 minutes

    while (serpAttempts < maxSerpAttempts) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
      serpAttempts++;

      console.log(`📊 Checking SERP run status (attempt ${serpAttempts}/${maxSerpAttempts})...`);
      const statusResponse = await fetch(`https://api.apify.com/v2/acts/scraperlink~google-search-results-serp-scraper/runs/${runId}`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      if (!statusResponse.ok) {
        console.error(`❌ SERP Status Error: ${statusResponse.status}`);
        continue;
      }

      const statusData = await statusResponse.json();
      console.log(`📊 SERP run status: ${statusData.data?.status} (attempt ${serpAttempts}/${maxSerpAttempts})`);

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
    console.log(`📊 SERP dataset ID: ${datasetId}`);

    if (!datasetId) {
      console.error(`❌ No dataset ID found in completed SERP run:`, finalStatusData);
      throw new Error('No dataset ID received from completed Apify SERP run');
    }

    // First wait 20 seconds for dataset to populate (like your Make.com)
    console.log(`⏳ Initial wait for SERP dataset to populate...`);
    await new Promise(resolve => setTimeout(resolve, 20000)); // Wait 20 seconds

    // Then poll dataset until we have results (hybrid approach)
    console.log(`⏳ Polling SERP dataset for results...`);
    let serpData = null;
    let datasetAttempts = 0;
    const maxDatasetAttempts = 60; // Wait up to 5 minutes

    while (datasetAttempts < maxDatasetAttempts) {
      console.log(`📊 Checking SERP dataset (attempt ${datasetAttempts + 1}/${maxDatasetAttempts})...`);
      const serpResultsResponse = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      if (!serpResultsResponse.ok) {
        console.error(`❌ SERP Results Error: ${serpResultsResponse.status}`);
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
        datasetAttempts++;
        continue;
      }

      serpData = await serpResultsResponse.json();
      console.log(`📊 SERP dataset has ${serpData.length} items`);
      console.log(`📊 SERP dataset sample:`, serpData.slice(0, 1));

      if (serpData && serpData.length > 0) {
        console.log(`✅ SERP results received: ${serpData.length} items`);
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
      datasetAttempts++;
    }

    if (!serpData || serpData.length === 0) {
      throw new Error('SERP dataset is empty after 5 minutes of polling');
    }
    console.log(`✅ SERP data received for: ${keyword}`);
    console.log(`📊 SERP data structure:`, Object.keys(serpData));

    // Parse SERP data - EXACTLY like your example structure
    console.log(`✅ SERP data received for: ${keyword}`);
    console.log(`📊 SERP data structure:`, Object.keys(serpData));
    
    // Your example shows: [{ search_term, knowledge_panel, results, related_keywords, next_page, next_start }]
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
      console.log(`📊 Found SERP results in array format`);
    } else if (serpData.results && Array.isArray(serpData.results)) {
      serpResults = serpData.results;
      searchTerm = serpData.search_term || keyword;
      knowledgePanel = serpData.knowledge_panel || null;
      relatedKeywords = serpData.related_keywords?.keywords || [];
      console.log(`📊 Found SERP results in object format`);
    } else {
      console.error(`❌ Unexpected SERP data structure for ${keyword}:`, serpData);
      throw new Error('Unexpected SERP data structure received from Apify');
    }
    
    console.log(`📊 SERP results count:`, serpResults.length);
    console.log(`📊 Search term:`, searchTerm);
    console.log(`📊 Related keywords count:`, relatedKeywords.length);

    // Extract URLs from SERP results - matches your example structure exactly
    const urls = serpResults.map(result => result.url).filter(url => url);
    
    console.log(`📊 Found ${urls.length} URLs to analyze`);
    
    if (urls.length === 0) {
      console.error(`❌ No URLs found in SERP results for ${keyword}:`, serpResults);
      throw new Error('No URLs found in SERP results');
    }

    // Step 2: Start Metrics actor asynchronously (like your Make.com flow)
    console.log(`📊 Starting Apify Metrics API for ${urls.length} URLs`);
    console.log(`📊 URLs to analyze:`, urls.slice(0, 3)); // Show first 3 URLs
    
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

    console.log(`📊 Metrics Response Status: ${metricsResponse.status} ${metricsResponse.statusText}`);
    console.log(`📊 Metrics Response Headers:`, Object.fromEntries(metricsResponse.headers.entries()));

    if (!metricsResponse.ok) {
      const errorText = await metricsResponse.text();
      console.error(`❌ Metrics API Error: ${errorText}`);
      throw new Error(`Metrics API failed: ${metricsResponse.status} ${metricsResponse.statusText}`);
    }

    // Get raw response text first
    const metricsResponseText = await metricsResponse.text();
    console.log(`📊 Raw Metrics response length: ${metricsResponseText.length}`);
    console.log(`📊 Raw Metrics response: ${metricsResponseText.substring(0, 1000)}...`);
    
    if (!metricsResponseText || metricsResponseText.trim() === '') {
      throw new Error('Empty response from Apify Metrics API');
    }

    let metricsRunData;
    try {
      metricsRunData = JSON.parse(metricsResponseText);
    } catch (parseError) {
      console.error(`❌ Metrics JSON parse error: ${parseError.message}`);
      console.error(`❌ Metrics response text: ${metricsResponseText}`);
      throw new Error(`Invalid JSON response from Apify Metrics: ${parseError.message}`);
    }

    const metricsRunId = metricsRunData.data?.id;
    console.log(`📊 Metrics run ID: ${metricsRunId}`);
    console.log(`📊 Full Metrics run data:`, JSON.stringify(metricsRunData, null, 2));

    if (!metricsRunId) {
      console.error(`❌ No run ID found in Metrics response:`, metricsRunData);
      throw new Error('No run ID received from Apify Metrics API');
    }

    // Wait for Metrics run to complete
    console.log(`⏳ Waiting for Metrics run to complete...`);
    let metricsRunAttempts = 0;
    const maxMetricsRunAttempts = 60; // Wait up to 5 minutes

    while (metricsRunAttempts < maxMetricsRunAttempts) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
      metricsRunAttempts++;

      console.log(`📊 Checking Metrics run status (attempt ${metricsRunAttempts}/${maxMetricsRunAttempts})...`);
      const metricsStatusResponse = await fetch(`https://api.apify.com/v2/acts/scrap3r~moz-da-pa-metrics/runs/${metricsRunId}`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      if (!metricsStatusResponse.ok) {
        console.error(`❌ Metrics Status Error: ${metricsStatusResponse.status}`);
        continue;
      }

      const metricsStatusData = await metricsStatusResponse.json();
      console.log(`📊 Metrics run status: ${metricsStatusData.data?.status} (attempt ${metricsRunAttempts}/${maxMetricsRunAttempts})`);

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
    console.log(`📊 Metrics dataset ID: ${metricsDatasetId}`);

    if (!metricsDatasetId) {
      console.error(`❌ No dataset ID found in completed Metrics run:`, finalMetricsStatusData);
      throw new Error('No dataset ID received from completed Apify Metrics run');
    }

    // First wait 20 seconds for dataset to populate (like your Make.com)
    console.log(`⏳ Initial wait for Metrics dataset to populate...`);
    await new Promise(resolve => setTimeout(resolve, 20000)); // Wait 20 seconds

    // Then poll dataset until we have results (hybrid approach)
    console.log(`⏳ Polling Metrics dataset for results...`);
    let metricsData = null;
    let metricsAttempts = 0;
    const maxMetricsAttempts = 60; // Wait up to 5 minutes

    while (metricsAttempts < maxMetricsAttempts) {
      console.log(`📊 Checking Metrics dataset (attempt ${metricsAttempts + 1}/${maxMetricsAttempts})...`);
      const metricsResultsResponse = await fetch(`https://api.apify.com/v2/datasets/${metricsDatasetId}/items`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      if (!metricsResultsResponse.ok) {
        console.error(`❌ Metrics Results Error: ${metricsResultsResponse.status}`);
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
        metricsAttempts++;
        continue;
      }

      metricsData = await metricsResultsResponse.json();
      console.log(`📊 Metrics dataset has ${metricsData.length} items`);
      console.log(`📊 Metrics dataset sample:`, metricsData.slice(0, 1));

      if (metricsData && metricsData.length > 0) {
        console.log(`✅ Metrics results received: ${metricsData.length} items`);
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
      metricsAttempts++;
    }

    if (!metricsData || metricsData.length === 0) {
      throw new Error('Metrics dataset is empty after 5 minutes of polling');
    }
    console.log(`✅ Metrics data received for ${metricsData.length} URLs`);
    console.log(`📊 Metrics data structure:`, Object.keys(metricsData));
    console.log(`📊 Metrics data sample:`, metricsData.slice(0, 2));

    // Validate metrics data structure
    if (!Array.isArray(metricsData)) {
      console.error(`❌ Invalid metrics data structure for ${keyword}:`, metricsData);
      throw new Error('Invalid metrics data structure received from Apify');
    }

    // Step 3: Combine SERP results with metrics - EXACTLY like your expected output
    const combinedResults = serpResults.map((result, index) => {
      // Find matching metrics by domain URL
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
    console.log(`📊 Sample combined result:`, combinedResults[0]);
    
    // Extract related keywords and knowledge panel from the first item if it's an array
    // (These are already extracted above, so we don't need to do it again)
    
    return {
      keyword: keyword,
      results: combinedResults,
      serp_features: relatedKeywords,
      knowledge_panel: knowledgePanel
    };

  } catch (error) {
    console.error(`❌ Apify API error for ${keyword}:`, error.message);
    console.error(`❌ Full error stack:`, error.stack);
    
    // Provide more specific error messages
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

// Main SERP analysis endpoint
app.post('/api/analyze-serps', rateLimitMiddleware, authMiddleware, async (req, res) => {
  const startTime = Date.now();
  const requestId = uuidv4();
  
  try {
    console.log(`🚀 Starting SERP analysis request: ${requestId}`);
    console.log(`👤 User: ${req.user.id} (${req.user.email})`);
    console.log(`📝 Request body:`, JSON.stringify(req.body, null, 2));
    
    const { keywords, country = "US", page = 1 } = req.body;
    
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

    // Get user's API keys - include failed keys that can be retried
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

    console.log(`🔑 Found ${apiKeys.length} API keys for user ${req.user.id}`);
    apiKeys.forEach((key, index) => {
      console.log(`  ${index + 1}. ${key.key_name} - Status: ${key.status} - Last used: ${key.last_used || 'Never'}`);
    });

    const results = [];
    const usedKeys = [];
    let currentKeyIndex = 0;

    // Process each keyword
    for (const keyword of keywords) {
      console.log(`🔍 Processing keyword: ${keyword}`);
      let success = false;
      let attempts = 0;
      const maxAttempts = Math.min(3, apiKeys.length);

      while (!success && attempts < maxAttempts) {
        const currentKey = apiKeys[currentKeyIndex % apiKeys.length];
        console.log(`🔑 Attempt ${attempts + 1}/${maxAttempts} with API key: ${currentKey.key_name}`);
        
        try {
          const serpResult = await callApifySerpApi(keyword, currentKey.api_key, country, page);
          
          // Calculate analysis metrics
          const domains = serpResult.results.map(r => r.url); // Use URL as domain for DA/PA
          const das = serpResult.results.map(r => r.domain_authority);
          const averageDA = das.reduce((sum, da) => sum + da, 0) / das.length;
          const lowDACount = das.filter(da => da < 35).length;
          const decision = averageDA < 50 && lowDACount >= 5 ? 'Write' : 'Skip';

          // Create detailed result with all required fields
          const result = {
            keyword,
            api_key_used: currentKey.key_name,
            domains: domains.slice(0, 5), // Top 5 domains
            average_da: Math.round(averageDA),
            low_da_count: lowDACount,
            decision,
            serp_features: serpResult.serp_features || [],
            full_results: serpResult.results, // Include full SERP data with DA/PA
            // Store detailed data for each result
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
          
          results.push(result);

          // Update key usage - mark as active if it was previously failed
          await supabase.from('api_keys').update({
            last_used: new Date().toISOString(),
            failure_count: 0,
            status: 'active' // Reset status to active on successful use
          }).eq('id', currentKey.id);

          usedKeys.push(currentKey.id);
          success = true;
          console.log(`✅ Successfully used API key: ${currentKey.key_name}`);
          
        } catch (error) {
          console.error(`❌ Error with API key ${currentKey.key_name}:`, error.message);
          console.error(`❌ Full error details:`, error);
          
          // Check if it's a rate limit, credit issue, or invalid key
          const isRateLimit = error.message.includes('rate') || error.message.includes('credit') || error.message.includes('429');
          const isInvalidKey = error.message.includes('Invalid API key') || error.message.includes('401');
          
          if (isRateLimit) {
            // Mark key as rate limited
            await supabase.from('api_keys').update({
              status: 'rate_limited',
              last_failed: new Date().toISOString(),
              failure_count: currentKey.failure_count + 1
            }).eq('id', currentKey.id);
            console.log(`⚠️ Marked API key as rate limited: ${currentKey.key_name}`);
          } else if (isInvalidKey) {
            // Mark key as failed permanently
            await supabase.from('api_keys').update({
              status: 'failed',
              last_failed: new Date().toISOString(),
              failure_count: currentKey.failure_count + 1
            }).eq('id', currentKey.id);
            console.log(`❌ Marked API key as failed: ${currentKey.key_name}`);
          } else {
            // Mark key as failed temporarily
            await supabase.from('api_keys').update({
              status: 'failed',
              last_failed: new Date().toISOString(),
              failure_count: currentKey.failure_count + 1
            }).eq('id', currentKey.id);
            console.log(`⚠️ Marked API key as failed: ${currentKey.key_name}`);
          }

          attempts++;
          currentKeyIndex++;
        }
      }

      if (!success) {
        // If all keys failed for this keyword, add a failure result
        const errorResult = {
          keyword,
          api_key_used: null, // No API key was successfully used
          error: 'All API keys failed or rate limited',
          decision: 'Error',
          detailed_results: []
        };
        
        console.log(`❌ Adding error result for ${keyword}:`, errorResult);
        results.push(errorResult);
      }
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

      // Store detailed SERP results in the new table
      try {
        const { data: analysisLog } = await supabase
          .from('analysis_logs')
          .select('id')
          .eq('request_id', requestId)
          .single();

        if (analysisLog) {
          const serpResultsToInsert = [];
          
          results.forEach(result => {
            if (result.detailed_results && Array.isArray(result.detailed_results)) {
              result.detailed_results.forEach(detail => {
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
              });
            }
          });

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
        }
      } catch (serpError) {
        console.error(`❌ Error storing detailed SERP results:`, serpError);
      }
    } catch (updateError) {
      console.error(`❌ Error updating analysis log:`, updateError);
    }

    const finalResults = results.map(result => {
      // Format SERP results as readable text
      const serpResultsText = result.full_results?.map(item => 
        `Position: ${item.position}\n` +
        `Title: ${item.title}\n` +
        `Description: ${item.description}\n` +
        `URL: ${item.url}\n` +
        `DA: ${item.domain_authority}\n` +
        `PA: ${item.page_authority}\n` +
        `Spam Score: ${item.spam_score}\n`
      ).join('\n') || '';

      // Format related keywords as readable text
      const relatedKeywordsText = result.serp_features?.map(item => 
        item.keyword
      ).join('\n') || '';

      // Format domains as readable text
      const domainsText = result.domains?.join('\n') || '';

      return {
        keyword: result.keyword,
        api_key_used: result.api_key_used,
        domains: result.domains || [],
        domains_text: domainsText, // Formatted domains
        average_da: result.average_da || 0,
        low_da_count: result.low_da_count || 0,
        decision: result.decision || 'Error',
        serp_features: result.serp_features || [],
        related_keywords_text: relatedKeywordsText, // Formatted related keywords
        full_results: result.full_results || [],
        serp_results_text: serpResultsText, // Formatted SERP results
        detailed_results: result.detailed_results || [], // Detailed results with domain, da, spam_score
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

// Simple test endpoint to debug issues
app.post('/api/test-simple', authMiddleware, async (req, res) => {
  try {
    console.log('🧪 Simple test endpoint called');
    console.log('👤 User:', req.user.id);
    console.log('📝 Request body:', req.body);
    
    // Test Supabase connection
    const { data: testData, error: testError } = await supabase
      .from('api_keys')
      .select('count')
      .eq('user_id', req.user.id)
      .limit(1);
    
    if (testError) {
      console.error('❌ Supabase test failed:', testError);
      return res.status(500).json({
        error: 'Database connection failed',
        details: testError.message
      });
    }
    
    // Test API keys
    const { data: apiKeys, error: keysError } = await supabase
      .from('api_keys')
      .select('*')
      .eq('user_id', req.user.id);
    
    if (keysError) {
      console.error('❌ API keys fetch failed:', keysError);
      return res.status(500).json({
        error: 'Failed to fetch API keys',
        details: keysError.message
      });
    }
    
    res.json({
      success: true,
      message: 'Simple test completed successfully',
      user_id: req.user.id,
      api_keys_count: apiKeys?.length || 0,
      api_keys: apiKeys?.map(key => ({
        id: key.id,
        name: key.key_name,
        status: key.status,
        provider: key.provider
      })) || [],
      supabase_connected: true
    });
    
  } catch (error) {
    console.error('❌ Simple test error:', error);
    res.status(500).json({
      error: 'Test failed',
      message: error.message,
      stack: error.stack
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

// Test endpoint for webhook URL
app.get('/api/test', (req, res) => {
  const baseUrl = process.env.VITE_API_BASE_URL || `http://localhost:${PORT}`;
  const webhookUrl = baseUrl.includes('localhost') 
    ? `http://localhost:${PORT}/api/analyze-serps`
    : `${baseUrl}/api/analyze-serps`;
    
  res.json({ 
    message: 'SERP Analyzer API is running',
    base_url: baseUrl,
    webhook_url: webhookUrl,
    environment: process.env.NODE_ENV || 'development',
    endpoints: {
      health: `${baseUrl}/api/health`,
      analyze: webhookUrl,
      test_apify: `${baseUrl}/api/test-apify`,
      debug_keys: `${baseUrl}/api/debug/keys`
    }
  });
});

// Comprehensive webhook test endpoint
app.post('/api/test-webhook', authMiddleware, async (req, res) => {
  try {
    const { keywords = ["test keyword"] } = req.body;
    
    console.log(`🧪 Testing webhook with keywords:`, keywords);
    
    // Get user's API keys
    const { data: apiKeys, error: keysError } = await supabase
      .from('api_keys')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('status', 'active')
      .limit(1);

    if (keysError || !apiKeys || apiKeys.length === 0) {
      return res.status(400).json({ 
        error: 'No active API keys found',
        message: 'Please add at least one active Apify API key'
      });
    }

    const testKey = apiKeys[0];
    console.log(`🧪 Using API key: ${testKey.key_name}`);
    
    // Test with first keyword
    const testKeyword = keywords[0] || "test keyword";
    const testResult = await callApifySerpApi(testKeyword, testKey.api_key);
    
    res.json({
      success: true,
      message: 'Webhook test successful',
      test_keyword: testKeyword,
      api_key_used: testKey.key_name,
      result_summary: {
        keyword: testResult.keyword,
        results_count: testResult.results.length,
        serp_features_count: testResult.serp_features?.length || 0,
        has_knowledge_panel: !!testResult.knowledge_panel
      },
      full_result: testResult
    });
    
  } catch (error) {
    console.error(`🧪 Webhook test failed:`, error.message);
    res.status(500).json({ 
      error: 'Webhook test failed', 
      details: error.message,
      message: 'Check your API keys and Apify account status'
    });
  }
});

// Debug endpoint to check API keys (requires authentication)
app.get('/api/debug/keys', authMiddleware, async (req, res) => {
  try {
    const { data: apiKeys, error } = await supabase
      .from('api_keys')
      .select('*')
      .eq('user_id', req.user.id);
    
    if (error) {
      return res.status(500).json({ error: 'Database error', details: error });
    }
    
    console.log(`🔍 Debug: Found ${apiKeys.length} API keys for user ${req.user.id}`);
    apiKeys.forEach((key, index) => {
      console.log(`  ${index + 1}. ID: ${key.id}, Name: "${key.key_name}", Status: ${key.status}`);
    });
    
    res.json({
      user_id: req.user.id,
      total_keys: apiKeys.length,
      keys: apiKeys.map(key => ({
        id: key.id,
        name: key.key_name,
        status: key.status,
        provider: key.provider,
        last_used: key.last_used,
        failure_count: key.failure_count,
        created_at: key.created_at
      }))
    });
  } catch (error) {
    console.error('Debug keys error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Test Apify API key endpoint
app.post('/api/test-apify', authMiddleware, async (req, res) => {
  try {
    const { apiKey } = req.body;
    
    if (!apiKey) {
      return res.status(400).json({ error: 'API key required' });
    }
    
    console.log(`🧪 Testing Apify API key: ${apiKey.substring(0, 8)}...`);
    
    // Test with a simple keyword using the same actor as your working Make.com flow
    const testResponse = await fetch('https://api.apify.com/v2/acts/scraperlink~google-search-results-serp-scraper/run-sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        "keyword": "test"
      })
    });
    
    const responseText = await testResponse.text();
    const responseData = testResponse.ok ? JSON.parse(responseText) : null;
    
    console.log(`🧪 Test response status: ${testResponse.status}`);
    console.log(`🧪 Test response data:`, responseData);
    
    res.json({
      status: testResponse.status,
      ok: testResponse.ok,
      response_text: responseText,
      response_data: responseData,
      api_key_tested: apiKey.substring(0, 8) + '...'
    });
    
  } catch (error) {
    console.error(`🧪 Test failed:`, error.message);
    res.status(500).json({ error: 'Test failed', details: error.message });
  }
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
