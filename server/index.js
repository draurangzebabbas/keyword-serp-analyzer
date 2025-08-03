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

// Real Apify SERP API integration
const callApifySerpApi = async (keyword, apiKey) => {
  console.log(`🔍 Analyzing keyword: ${keyword} with API key: ${apiKey.substring(0, 8)}...`);
  
  try {
    // Step 1: Get SERP results using scraperlink/google-search-results-serp-scraper
    console.log(`📡 Calling Apify SERP API for keyword: ${keyword}`);
    const serpResponse = await fetch('https://api.apify.com/v2/acts/scraperlink~google-search-results-serp-scraper/run-sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        "keyword": keyword,
        "num": 10, // Get top 10 results
        "country": "us",
        "language": "en"
      })
    });

    if (!serpResponse.ok) {
      const errorText = await serpResponse.text();
      console.error(`❌ SERP API Error Response: ${errorText}`);
      throw new Error(`SERP API failed: ${serpResponse.status} ${serpResponse.statusText} - ${errorText}`);
    }

    const serpData = await serpResponse.json();
    console.log(`✅ SERP data received for: ${keyword}`);
    console.log(`📊 SERP data structure:`, Object.keys(serpData));
    console.log(`📊 SERP results count:`, serpData.results?.length || 0);

    // Extract URLs from SERP results
    const urls = serpData.results?.map(result => result.url) || [];
    console.log(`📊 Found ${urls.length} URLs to analyze`);
    
    // Validate SERP data structure
    if (!serpData.results || !Array.isArray(serpData.results)) {
      console.error(`❌ Invalid SERP data structure for ${keyword}:`, serpData);
      throw new Error('Invalid SERP data structure received from Apify');
    }

    if (urls.length === 0) {
      throw new Error('No URLs found in SERP results');
    }

    // Step 2: Get DA/PA metrics using scrap3r/moz-da-pa-metrics
    console.log(`📊 Calling Apify Metrics API for ${urls.length} URLs`);
    const metricsResponse = await fetch('https://api.apify.com/v2/acts/scrap3r~moz-da-pa-metrics/run-sync', {
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
      console.error(`❌ Metrics API Error Response: ${errorText}`);
      throw new Error(`Metrics API failed: ${metricsResponse.status} ${metricsResponse.statusText} - ${errorText}`);
    }

    const metricsData = await metricsResponse.json();
    console.log(`✅ Metrics data received for ${metricsData.length} URLs`);
    console.log(`📊 Metrics data structure:`, Object.keys(metricsData));
    console.log(`📊 Metrics data sample:`, metricsData.slice(0, 2));

    // Validate metrics data structure
    if (!Array.isArray(metricsData)) {
      console.error(`❌ Invalid metrics data structure for ${keyword}:`, metricsData);
      throw new Error('Invalid metrics data structure received from Apify');
    }

    // Step 3: Combine SERP results with metrics
    const combinedResults = serpData.results?.map((result, index) => {
      const metrics = metricsData.find(m => m.domain === result.url) || {};
      
      return {
        position: result.position,
        url: result.url,
        title: result.title,
        description: result.description,
        domain_authority: metrics.domain_authority || 0,
        page_authority: metrics.page_authority || 0,
        spam_score: metrics.spam_score || 0
      };
    }) || [];

    console.log(`✅ Combined ${combinedResults.length} results for: ${keyword}`);
    
    return {
      keyword: keyword,
      results: combinedResults,
      serp_features: serpData.related_keywords?.keywords || [],
      knowledge_panel: serpData.knowledge_panel || null
    };

  } catch (error) {
    console.error(`❌ Apify API error for ${keyword}:`, error.message);
    
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
    const { keywords } = req.body;
    
    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({ 
        error: 'Invalid request', 
        message: 'Keywords array is required and must not be empty' 
      });
    }

    if (keywords.length > 30) {
      return res.status(400).json({ 
        error: 'Too many keywords', 
        message: 'Maximum 30 keywords allowed per request' 
      });
    }

    // Log the request
    await supabase.from('analysis_logs').insert({
      user_id: req.user.id,
      request_id: requestId,
      keywords: keywords,
      status: 'pending'
    });

    // Get user's API keys - include failed keys that can be retried
    const { data: apiKeys, error: keysError } = await supabase
      .from('api_keys')
      .select('*')
      .eq('user_id', req.user.id)
      .in('status', ['active', 'failed', 'rate_limited'])
      .order('last_used', { ascending: true, nullsFirst: true });

    if (keysError || !apiKeys || apiKeys.length === 0) {
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
      let success = false;
      let attempts = 0;
      const maxAttempts = Math.min(3, apiKeys.length);

      while (!success && attempts < maxAttempts) {
        const currentKey = apiKeys[currentKeyIndex % apiKeys.length];
        
        try {
          const serpResult = await callApifySerpApi(keyword, currentKey.api_key);
          
          // Calculate analysis metrics
          const domains = serpResult.results.map(r => r.url); // Use URL as domain for DA/PA
          const das = serpResult.results.map(r => r.domain_authority);
          const averageDA = das.reduce((sum, da) => sum + da, 0) / das.length;
          const lowDACount = das.filter(da => da < 35).length;
          const decision = averageDA < 50 && lowDACount >= 5 ? 'Write' : 'Skip';

          results.push({
            keyword,
            api_key_used: currentKey.key_name, // Add the API key name used
            domains: domains.slice(0, 5), // Top 5 domains
            average_da: Math.round(averageDA),
            low_da_count: lowDACount,
            decision,
            serp_features: serpResult.serp_features?.slice(0, 3) || [],
            full_results: serpResult.results // Include full SERP data
          });

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
          console.error(`Error with API key ${currentKey.key_name}:`, error.message);
          
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
        results.push({
          keyword,
          api_key_used: null, // No API key was successfully used
          error: 'All API keys failed or rate limited',
          decision: 'Error'
        });
      }
    }

    const processingTime = Date.now() - startTime;

    // Update the log with results
    await supabase.from('analysis_logs').update({
      status: 'completed',
      results: results,
      api_keys_used: usedKeys,
      processing_time: processingTime
    }).eq('request_id', requestId);

    res.json({
      request_id: requestId,
      keywords_processed: keywords.length,
      processing_time: processingTime,
      results: results.map(result => ({
        keyword: result.keyword,
        api_key_used: result.api_key_used, // Include the API key name used
        domains: result.domains,
        average_da: result.average_da,
        low_da_count: result.low_da_count,
        decision: result.decision,
        serp_features: result.serp_features,
        full_results: result.full_results // Complete SERP data with DA/PA metrics
      }))
    });

  } catch (error) {
    console.error('SERP analysis error:', error);
    
    const processingTime = Date.now() - startTime;
    
    // Update log with error
    await supabase.from('analysis_logs').update({
      status: 'failed',
      error_message: error.message,
      processing_time: processingTime
    }).eq('request_id', requestId);

    res.status(500).json({ 
      error: 'Analysis failed', 
      message: 'An error occurred during SERP analysis' 
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
    
    // Test with a simple keyword
    const testResponse = await fetch('https://api.apify.com/v2/acts/scraperlink~google-search-results-serp-scraper/run-sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        "keyword": "test",
        "num": 1
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
