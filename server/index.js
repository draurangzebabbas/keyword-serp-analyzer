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

// Mock function to simulate Apify SERP API call
const callApifySerpApi = async (keyword, apiKey) => {
  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
  
  // Simulate random success/failure
  if (Math.random() < 0.1) { // 10% failure rate
    throw new Error('API key rate limited or invalid');
  }

  // Mock SERP results
  const mockDomains = [
    'wikipedia.org', 'amazon.com', 'reddit.com', 'youtube.com', 'medium.com',
    'linkedin.com', 'twitter.com', 'facebook.com', 'instagram.com', 'tiktok.com'
  ];

  return {
    results: mockDomains.slice(0, 10).map((domain, index) => ({
      domain,
      url: `https://${domain}/search?q=${encodeURIComponent(keyword)}`,
      position: index + 1,
      title: `${keyword} - Results from ${domain}`,
      da: Math.floor(Math.random() * 100) + 1, // Mock Domain Authority
      pa: Math.floor(Math.random() * 100) + 1, // Mock Page Authority
    }))
  };
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

    // Get user's API keys
    const { data: apiKeys, error: keysError } = await supabase
      .from('api_keys')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('status', 'active')
      .order('last_used', { ascending: true, nullsFirst: true });

    if (keysError || !apiKeys || apiKeys.length === 0) {
      await supabase.from('analysis_logs').update({
        status: 'failed',
        error_message: 'No active API keys available',
        processing_time: Date.now() - startTime
      }).eq('request_id', requestId);

      return res.status(400).json({ 
        error: 'No API keys', 
        message: 'Please add at least one active Apify API key' 
      });
    }

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
          const domains = serpResult.results.map(r => r.domain);
          const das = serpResult.results.map(r => r.da);
          const averageDA = das.reduce((sum, da) => sum + da, 0) / das.length;
          const lowDACount = das.filter(da => da < 35).length;
          const decision = averageDA < 50 && lowDACount >= 5 ? 'Write' : 'Skip';

          results.push({
            keyword,
            domains: domains.slice(0, 5), // Top 5 domains
            average_da: Math.round(averageDA),
            low_da_count: lowDACount,
            decision,
            serp_features: ['Featured Snippet', 'People Also Ask', 'Related Searches'].slice(0, Math.floor(Math.random() * 3) + 1)
          });

          // Update key usage
          await supabase.from('api_keys').update({
            last_used: new Date().toISOString(),
            failure_count: 0
          }).eq('id', currentKey.id);

          usedKeys.push(currentKey.id);
          success = true;
          
        } catch (error) {
          console.error(`Error with API key ${currentKey.id}:`, error.message);
          
          // Mark key as failed temporarily
          await supabase.from('api_keys').update({
            status: 'rate_limited',
            last_failed: new Date().toISOString(),
            failure_count: currentKey.failure_count + 1
          }).eq('id', currentKey.id);

          attempts++;
          currentKeyIndex++;
        }
      }

      if (!success) {
        // If all keys failed for this keyword, add a failure result
        results.push({
          keyword,
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
      results: results
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
    : baseUrl;
    
  res.json({ 
    message: 'SERP Analyzer API is running',
    base_url: baseUrl,
    webhook_url: webhookUrl,
    environment: process.env.NODE_ENV || 'development'
  });
});

// Start server
app.listen(PORT, () => {
  const baseUrl = process.env.VITE_API_BASE_URL || `http://localhost:${PORT}`;
  const isProduction = baseUrl.includes('onrender.com');
  
  console.log(`🚀 SERP Analysis API server running on port ${PORT}`);
  console.log(`📡 Health check: ${baseUrl.replace('/api/analyze-serps', '/api/health')}`);
  console.log(`🔗 Webhook URL: ${baseUrl}`);
  console.log(`✅ Supabase connected: ${!!supabaseUrl}`);
  console.log(`🌍 Environment: ${isProduction ? 'Production' : 'Development'}`);
});

export default app;