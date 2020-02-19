var express = require('express')
const https = require('https')
const fs = require('fs');
var app = express()

const randomRange = (min, max) => {
  return Math.floor(Math.random() * (max - min) + min); 
}

const generateMockLiveNextData = (randomNumber) => {
  let run =   Array(100).fill(0).map((e,i)=>i+randomNumber);
  let data = [];
  run.forEach(i => {
    const dataInfo = {};
    dataInfo.id = i;
    dataInfo.name = i;
    dataInfo.ecGroup = 'ECgrp' + i;
    dataInfo.heathStatus = i%2 ? "Healthy" : "Unhealthy";
    dataInfo.trafficForward = i%2 ? true : false;
    data.push(dataInfo);
  })
  
  console.log('data count:'+data.length);
  return JSON.stringify(data);
}

var WebSocketServer = require('ws').Server,
  wss = new WebSocketServer({port: 40511})

wss.on('connection', function (ws) {
  ws.on('message', function (message) {
    console.log('received: %s', message)
  })

  setInterval(
      () => {
        let random = randomRange(100, 5000);
        console.log('Random'+ random);
        ws.send(generateMockLiveNextData(random));
      },
      5000
    )
})


app.get('/', function (req, res) {
    res.sendFile(__dirname + '/ws.html');
})

https.createServer({
  cert: fs.readFileSync('./server.cert'),
  key: fs.readFileSync('./server.key')
}, app)
.listen(3005, function () {
  console.log('Example app listening on port 3005!')
})
 