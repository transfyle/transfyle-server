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

const API_KEY = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxIiwianRpIjoiYmExYWNlZTY3MzhjMzI4MWE4NTBjZDkyZWE4NmE3NGQ1OTU4MDgyOTQxNjc2YTJmNTJhYmQ4ZjYxOGJiOGZhODI4ZWMzYmU2ZDVjMjZiMmYiLCJpYXQiOjE3Nzg5MzcxODMuNTQ2MDA5LCJuYmYiOjE3Nzg5MzcxODMuNTQ2MDExLCJleHAiOjQ5MzQ2MTA3ODMuNTM5OTQxLCJzdWIiOiI3NTU4MTAzNyIsInNjb3BlcyI6WyJ1c2VyLnJlYWQiLCJ1c2VyLndyaXRlIiwidGFzay5yZWFkIiwidGFzay53cml0ZSIsIndlYmhvb2sucmVhZCIsIndlYmhvb2sud3JpdGUiLCJwcmVzZXQucmVhZCIsInByZXNldC53cml0ZSJdfQ.UIYG0uI3F8IYcH0BrIcl-6qrzDj70PaV3jkY8gKvLTe5abXxHO3gg63PTYvor9-PtAsfIAAxfhPJ3qEqUAfV7fTe58eulgDQ3zBeGmOBJqbEyPKvKXAzxLy1qClXuut1xibHva6nu1SoQkDVPs3Hxivt39fWgUzEV5WLdY85lHGkPyTRn4HqPsghJe0_kBjPBtz5SGWp4oSwGy0MPwKakadVgdvI06rbz66WYNKuihvu-lffEpWvEG6RS7FZU-hKnS_hT2enfDnkY42TyfWmMd1Ww--uKt_yWrZg71Hltn7SkftNsvX1Pzvs6M_bBcvQI61lS1wBRBxFKy3s41esd02jCSMJQ0JLV3XlRDyBNGraUzZKmsqSBomrcFd0uHcDdGEyYidIF-u5s6HWKSqQYGN_0VYvMGZGaMfnAOWXRYmdfBY-JtezxcfkLx8zEWCkD4xLo4E2vFdW6sQXj3_EKxf-dsNeJVSzE3SbXNGntVqPpv5xke2VhhJcIMuIpwGds1dj1ssFwnXy_juQ3l1YwB4iyiNowkb871D99wicjBIDvXucPy4upB7DppbC2XvaG80M8Vua8Iuo6hV9aqCdpgob1aVtvpjxmueiOqXfczzlERRvXC6_yyc72OHD6lF45nYzzo9evlPIgkc6pPYkvJJ2wubibHUSPFK067Fc9wg';

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
    console.log('Creating CloudConvert job...');
    const jobRes = await fetch('https://api.cloudconvert.com/v2/jobs', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Type': 'application/json',
        'User-Agent': 'Transfyle/1.0'
      },
      body: JSON.stringify({
        tasks: {
          'upload-pdf': {
            operation: 'import/upload'
          },
          'compress-pdf': {
            operation: 'optimize',
            input: 'upload-pdf',
            input_format: 'pdf',
            output_format: 'pdf',
            quality: quality
          },
          'export-pdf': {
            operation: 'export/url',
            input: 'compress-pdf'
          }
        }
      })
    });

    if (!jobRes.ok) {
      const errText = await jobRes.text();
      console.error('CloudConvert error response:', errText);
      throw new Error('CloudConvert job failed: ' + jobRes.status + ' — ' + errText);
    }
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
