const express = require('express');
const path = require('path');
const resultsApi = require('./server/results-api');

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '50mb' }));
app.use('/api/results', resultsApi);
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`DIGITAL TWEEN - Tower Crane Load Stabilizer Simulator running at http://localhost:${PORT}`);
});
