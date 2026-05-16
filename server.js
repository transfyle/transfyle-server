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

const API_KEY = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxIiwianRpIjoiYzgyMzk4ZTgyNTFmMGM3OTAzMGMwOWE5YTc5ZGNmYmI5MWYyMWRkMDQ0MzQ2ODk2NjJhZmI1NWU3ODFiODAwNTRlMzY5YTQ4MTFlOTViNzIiLCJpYXQiOjE3Nzg5MzU5MzMuMzM4ODI1LCJuYmYiOjE3Nzg5MzU5MzMuMzM4ODI2LCJleHAiOjQ5MzQ2MDk1MzMuMzMyMDI0LCJzdWIiOiI3NTU4MTAzNyIsInNjb3BlcyI6WyJ0YXNrLnJlYWQiLCJ0YXNrLndyaXRlIiwidXNlci5yZWFkIiwidXNlci53cml0ZSIsIndlYmhvb2sucmVhZCIsIndlYmhvb2sud3JpdGUiXX0.RHK1AhZXqIJO3yojXhnPT5IKDF82Lnu15P6hWRGqpks3DVWwiVISGj-pZhJPNi2p7JldBGsRIoljBcX_1BclP65FOC6adl56F7dGoKukOHug8MWYD7nswTtbABEhAuUUUAEiSjlWzeSwzXLxD1jE0LI5Al9e85C8RDOVTHVO0gmRpx2Aab_Hf9bxLhQMmHNfG_MNGgXxH3TW7f8QeY0t-GaxP2cLGQO4g6rJDmAkEdw6bo2GE6QbEJulcdnZ6duEdSDU_8iBLUGlsospfJwHRp_O32MLo8J1Ao-DBh6k7jlsQdvvrZKYql3uD7E0mcqIwmtbxGwfBv-dk3sdosBzk0vc13phRKC0xjho0CLk8Ov8mYt2BFbIQR8eR1nYXjqNIxWQgMYuLk9-XZdsAmoiustW7kak96Ruc_D_pAwOAWbS1ndW3rveDehs-0P4w4QjJ__r07FUnleh-VBa-QPbNyTgwIKXvUXZ1hQsJ7LWUF4iFmwP5nrSpN49ADuOckXdevc2lTUi62M6vvY5Aty8Pv5uQ1qiVOeOs48XL2JTys7fogKQBHn_UMmL-jPeina36-v95WIxAcWGbdYu26mHw4vY7cH83Y4Ji_6L8r3ucY1Dh0Pzr-Ka6Lhd7USp3VnuwuTIUeIzQUKugrwHT2DE43hOn0fXkcEEjeBQ_PUWGvY';

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
          'upload-pdf': { operation: 'import/upload' },
          'compress-pdf': {
            operation: 'convert',
            input: 'upload-pdf',
            input_format: 'pdf',
            output_format: 'pdf',
            engine: 'ghostscript',
            pdf_settings: {
              pdf_profile: 'ebook',
              downsample_color_images: true,
              color_image_resolution: 150,
              downsample_grayscale_images: true,
              grayscale_image_resolution: 150
            }
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
