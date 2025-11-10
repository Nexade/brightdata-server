require('dotenv').config();
const express = require('express');
const axios = require('axios');
const router = express.Router();
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({ origin: '*' }));
app.options('/*', cors());

app.use('/api', router); 

const BRIGHT_DATA_API_KEY = process.env.BRIGHT_DATA_API_KEY;
if (!BRIGHT_DATA_API_KEY) console.log('Bright Data API key is missing');

const DISCOVER_API_URL = 'https://api.brightdata.com/datasets/v3/trigger?dataset_id=gd_m8ebnr0q2qlklc02fz&include_errors=true&type=discover_new&discover_by=location';
const REVIEWS_API_URL = 'https://api.brightdata.com/datasets/v3/trigger?dataset_id=gd_luzfs1dn2oa0teb81&include_errors=true&limit_multiple_results=30';

// Store active requests
const activeRequests = new Map();

// Helper: Check if input is a Google Maps URL
function isGoogleMapsUrl(input) {
  return /https?:\/\/(www\.)?google\..+\/maps/.test(input);
}

// Polling function to check dataset status
async function pollDatasetResult(requestId, datasetId) {
  const statusUrl = `https://api.brightdata.com/datasets/v3/request/${requestId}/status`;
  const resultUrl = `https://api.brightdata.com/datasets/v3/request/${requestId}/result`;
  
  let status = 'pending';
  let attempts = 0;
  
  while (status !== 'completed' && attempts < 60) { // Max 60 attempts (1 minute)
    attempts++;
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
    
    try {
      const statusResponse = await axios.get(statusUrl, {
        headers: { "Authorization": `Bearer ${BRIGHT_DATA_API_KEY}` }
      });
      
      status = statusResponse.data?.status;
      if (status === 'completed') break;
      if (status === 'failed') throw new Error('Dataset processing failed');
    } catch (error) {
      console.error('Status check error:', error.message);
    }
  }
  
  if (status !== 'completed') {
    throw new Error('Dataset processing timed out');
  }
  
  const resultResponse = await axios.get(resultUrl, {
    headers: { "Authorization": `Bearer ${BRIGHT_DATA_API_KEY}` }
  });
  
  return resultResponse.data;
}

// Main endpoint to initiate requests
router.post('/get-reviews', async (req, res) => {

  try {
    const { input } = req.body;
    
    if (!input) return res.status(400).json({ error: "Input is required" });

    // Generate unique request ID
    const requestId = Date.now().toString();
    activeRequests.set(requestId, { status: 'processing' });

    // Process request in background
    processRequest(requestId, input);
    
    return res.json({ 
      message: "Request processing started", 
      requestId 
    });

  } catch (error) {
    console.error('Initialization error:', error.message);
    res.status(500).json({ error: 'Failed to initiate request' });
  }
});

// Endpoint to check request status
router.get('/request-status/:requestId', async (req, res) => {
  const requestId = req.params.requestId;
  const request = activeRequests.get(requestId);
  
  if (!request) return res.status(404).json({ error: "Request not found" });
  
  res.json({
    status: request.status,
    result: request.result,
    error: request.error
  });
});

// Background processing function
async function processRequest(requestId, input) {
  try {
    let businessUrl;
    
    // Handle URL or business search
    if (isGoogleMapsUrl(input)) {
      businessUrl = input;
    } else {
      const discoverData = { keyword: input, country: 'AUS', lat: -16, long: 145, zoom_level: 1 };
      const discoverResponse = await axios.post(DISCOVER_API_URL, JSON.stringify([discoverData]), {
        headers: { "Authorization": `Bearer ${BRIGHT_DATA_API_KEY}`, "Content-Type": "application/json" }
      });
      
      const requestId = discoverResponse.data?.[0]?.request_id;
      console.log(discoverResponse);
      if (!requestId) throw new Error('No request ID returned from discovery');
      
      const discoverResult = await pollDatasetResult(requestId, 'gd_m8ebnr0q2qlklc02fz');
      const results = discoverResult?.[0]?.data?.results;
      if (!results?.length) throw new Error('No businesses found');
      
      businessUrl = results[0].url;
    }
    
    // Fetch reviews
    const reviewData = {
    url: businessUrl,
    days_limit: 1000
  };

  // Step 1: Trigger the dataset collection
  const triggerResponse = await axios.post(REVIEWS_API_URL, 
    JSON.stringify([reviewData]),
    {
      headers: {
        "Authorization": `Bearer ${BRIGHT_DATA_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );


  const snapshotId = triggerResponse.data?.snapshot_id;

  if (!snapshotId) {
    throw new Error('No snapshot ID returned');
  }

  // Step 2: Poll for results until they're ready
  const resultUrl = `https://api.brightdata.com/datasets/v3/snapshot/${snapshotId}`;
  let resultData = null;

  for (let attempt = 0; attempt < 20; attempt++) { // try up to ~10 minutes
    await new Promise(resolve => setTimeout(resolve, 30000)); // wait 30s between polls

    const resultResponse = await axios.get(resultUrl, {
      headers: {
        "Authorization": `Bearer ${BRIGHT_DATA_API_KEY}`
      }
    });

    // Bright Data sometimes wraps the result in an array
    console.log(`Response (${attempt}):`);
    const snapshot = Array.isArray(resultResponse.data)
      ? resultResponse.data[0]
      : resultResponse.data;
    

    if (snapshot.status != "running") {
      resultData = snapshot;
      break;
    }

    console.log(`Snapshot still processing (status: ${snapshot.status}), retrying...`);
  }

  if (!resultData) {
    throw new Error("Snapshot not ready after multiple attempts.");
  }

  console.log((typeof resultData) + " - type");
  let raw = resultData;
  let parsed = '';
  if (typeof raw === "string") {
    // Messy string case → clean it up into a valid JSON array
    let fixed = `[${raw.replace(/}\s+{/g, '},{')}]`;
    parsed = JSON.parse(fixed);
  } else if (Array.isArray(raw)) {
    // Already an array → use it directly
    parsed = raw;
  } else if (typeof raw === "object") {
    // Single object wrapped → put it in an array for consistency
    parsed = [raw];
  } else {
    throw new Error("Unexpected Bright Data format");
  }
  console.log(JSON.stringify(parsed).substring(0,200));

  console.log("Final reviews result:", JSON.stringify(resultData).substring(0,50));
    activeRequests.set(requestId, {
      status: 'completed',
      result: parsed,
    });
  return resultData || [];

      
  } catch (error) {
    console.error('Processing error:', error.message);
    activeRequests.set(requestId, {
      status: 'failed',
      error: error.message
    });
  }
}

// Cleanup old requests
setInterval(() => {
  const now = Date.now();
  for (const [requestId, request] of activeRequests) {
    if (now - parseInt(requestId) > 900000) { // 10 minutes
      activeRequests.delete(requestId);
    }
  }
}, 60000); // Cleanup every minute

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));