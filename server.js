const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');

const app = express();

// Trust Render proxy
app.set('trust proxy', true);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// Allow ALL origins
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

app.use(express.json());

const API_KEY = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxIiwianRpIjoiOWE0M2ExOTViYjIxMWE3YmQyZDgxZjEzMmYyMDcwMTczMzljMTMyNzkzMTBlMmY4N2U3MTkzMzI1Njk1NjVjNjRhMTAwM2NiM2VlYjBmOGUiLCJpYXQiOjE3Nzg5MjAzMzIuNjczOTQsIm5iZiI6MTc3ODkyMDMzMi42NzM5NDIsImV4cCI6NDkzNDU5MzkzMi42Njk1ODgsInN1YiI6Ijc1NTgxMDM3Iiwic2NvcGVzIjpbInVzZXIucmVhZCIsInVzZXIud3JpdGUiLCJ0YXNrLnJlYWQiLCJ0YXNrLndyaXRlIiwid2ViaG9vay5yZWFkIiwid2ViaG9vay53cml0ZSIsInByZXNldC5yZWFkIiwicHJlc2V0LndyaXRlIl19.dFbCWDRI9pn4JKeSHQDIIG80Jf660onqmgwaAeJeuhUdvN6ojEM8h4S6vulxzKwfhgeQMd_WDke1IknQOBTp0rSuD6x3HDAfshilhQwvkYQSrBRpDvPUWyXT1v38LjeFhjT2NcoWda7KQd-kh3D878awEMgWu2f8HpxOAIhjblt9goy8SGan1YGux9Lf6rLLOULId4QWvYy2lyBCx6b2G8UZ2w86Q16hwMcYoVuMXtfqWfJ-5_VO8Rl7g4vS8pu15un0zN8pdPedxtRDr4WUtUJ0HO2SHYo02ClPKKmj6V5aUsC2DH59S7Da0myLa7KOjZXEQaDo7KDevxTZtlIwo8Hrzk_4G-wZ5LRppu6GZ2Duy04d1gwfq1jv79gFGK7fUOR-Gm-paMcgfjZRxnxbXe3lh-3a2Dx0iZDK-5lO9T-D1EocNiI8huQy80fgseI2iCP9Gqh0bvi052-QMtyk_9QGUN4G87EKYNLkxbqRaeMqNU8mvOn2TK8VQX6JeU1edhS_3IjfSK4MitAA3dnPWq5JR9c4yj6aTyt0kFJk3MhZhjbhPkk2WMeSv9BF4OBzGMJSlc-eGEjcr9PAipOYwJPXcP-wp-Tp6C7zSFJ9prJiNHNVZqdhhRwHoKh3shhCpkev4MsaEsHfYltEiVjCo42xIiprDyHWzqmrHaAwxnc';

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Transfyle Server Running ✅' });
});

// Compress PDF endpoint
app.post('/compress-pdf', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const quality = parseInt(req.body.quality) || 65;

    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    if (file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Only PDF files allowed' });

    console.log(`Compressing: ${file.originalname} (${(file.size/1024/1024).toFixed(1)}MB) quality:${quality}`);

    // Step 1 — Create CloudConvert job
    const jobRes = await fetch('https://api.cloudconvert.com/v2/jobs', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        tasks: {
          'upload-pdf': { operation: 'import/upload' },
          'compress-pdf': {
            operation: 'optimize',
            input: 'upload-pdf',
            input_format: 'pdf',
            output_format: 'pdf',
            engine: 'ghostscript',
            quality: quality
          },
          'export-pdf': {
            operation: 'export/url',
            input: 'compress-pdf'
          }
        }
      })
    });

    if (!jobRes.ok) throw new Error('CloudConvert job failed: ' + jobRes.status);
    const job = await jobRes.json();

    // Step 2 — Upload file
    const uploadTask = job.data.tasks.find(t => t.name === 'upload-pdf');
    const form = new FormData();
    Object.entries(uploadTask.result.form.parameters).forEach(([k, v]) => form.append(k, v));
    form.append('file', file.buffer, { filename: file.originalname, contentType: 'application/pdf' });

    const uploadRes = await fetch(uploadTask.result.form.url, { method: 'POST', body: form });
    if (!uploadRes.ok) throw new Error('Upload failed: ' + uploadRes.status);

    // Step 3 — Wait for completion
    let exportTask = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const statusRes = await fetch(`https://api.cloudconvert.com/v2/jobs/${job.data.id}`, {
        headers: { 'Authorization': 'Bearer ' + API_KEY }
      });
      const statusData = await statusRes.json();
      const tasks = statusData.data.tasks;
      exportTask = tasks.find(t => t.name === 'export-pdf');
      if (exportTask?.status === 'finished') break;
      if (tasks.some(t => t.status === 'error')) throw new Error('CloudConvert compression error');
    }

    if (!exportTask?.result?.files?.[0]?.url) throw new Error('No output file');

    // Step 4 — Download and send back
    const dlRes = await fetch(exportTask.result.files[0].url);
    const buffer = await dlRes.buffer();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="compressed.pdf"`);
    res.setHeader('X-Original-Size', file.size);
    res.setHeader('X-Compressed-Size', buffer.length);
    res.send(buffer);

    console.log(`Done: ${(file.size/1024/1024).toFixed(1)}MB → ${(buffer.length/1024/1024).toFixed(1)}MB`);

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Transfyle server running on port ${PORT}`));
