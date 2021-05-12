const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const app = express();
const port = 3000;

app.use(express.static(path.join(__dirname, 'client')));
app.use('/dist', express.static(path.join(__dirname, '/../dist')));
app.use(bodyParser.text());

app.post('/api', ({ body }, res) => {
  console.log(`/api => { body: ${body} }`);
  res.send('ok');
});

app.post('/api/:status', ({ params, body, headers }, res) => {
  const status = +params.status;
  const payload = { body, header: headers['x-retry-context'] };
  console.log(`/api/${status} => ${JSON.stringify(payload)}`);
  res.status(status).send(`Status: ${status}`);
});

app.listen(port, () => {
  console.log(`listening at http://localhost:${port}`);
});
