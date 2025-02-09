const zlib = require('zlib');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const websocket = require('ws');
const Stream = require('stream');
const url = require('url');

module.exports = config=>{
  startTonel(config);
}

function startTonel(config){
  let urlData = url.parse(config.localServer || config.local);
  let protocol = urlData.protocol == 'https:' ? https : http;
  let ECDHKey;
  let ECDHSecret;
  let pingStart;

  console.log('Open socket client connection:', (config.remoteServer || config.remote));
  let socket = new websocket(config.remoteServer || config.remote);
  socket.on('error', e=>{
    console.error('% Client socket error', e);
  });
  socket.on('unexpected-response', (req, res)=>{
    console.error('unexpected-response', res.statusMessage);

    return setTimeout(()=>{
      startTonel(config);
    }, 5000);
  });

  socket.on('message', data=>{
    try{
      data = JSON.parse(data);
    }catch(e){}

    if(data === 'pong'){
      if(Date.now() - pingStart > 1000){
        socket.doping();
      }
      else{
        setTimeout(()=>{
          socket.doping();
        }, 1000);
      }

      return;
    }

    if(data.type == 'ECDH'){
      if(!ECDHKey){
        ECDHKey = crypto.createECDH('secp521r1');
        socket.send(JSON.stringify({type: 'ECDH', keys: ECDHKey.generateKeys()}));
      }
      
      ECDHSecret = ECDHKey.computeSecret(Buffer.from(data.keys.data));
      return;
    }
    
    if(data.type == 'secret' && ECDHSecret){
      let cipher = crypto.createDecipheriv('aes-192-cbc', ECDHSecret.slice(0,24), new Uint8Array(data.iv_key));
      
      data = cipher.update(data.data, 'base64', 'utf8');
      data += cipher.final('utf8');
      
      try{
        data = JSON.parse(data);
      }catch(e){}
    }

    if(data.type == 'connected'){
      if(config.ECDH){
        if(!ECDHKey){
          ECDHKey = crypto.createECDH('secp521r1');
          socket.send(JSON.stringify({type: 'ECDH', keys: ECDHKey.generateKeys()}));
        }
      }
      return;
    }

    if(data.type == 'auth' && config.apikey){
      socket.send(JSON.stringify({type: 'auth', apikey: config.apikey}));
      return;
    }

    if(data.type == 'cancelResponse'){
      socket.cancelResponse(data);
      return;
    }
    
    if(data.type == 'requestStart'){
      socket.requestStart(data);
      return;
    }
    if(data.type == 'requestPart'){
      socket.requestPart(data);
      return;
    }
    if(data.type == 'requestEnd'){
      socket.requestEnd(data);
      return;
    }

    console.warn('> Client socket recieve data', data);
  });
  
  socket._callbacks = {};
  socket.send = (function(originalSend) {
    return function(data){
      data = JSON.stringify(data);

      if(ECDHSecret){
        const iv_key = crypto.randomFillSync(new Uint8Array(16));
        const cipher = crypto.createCipheriv('aes-192-cbc', ECDHSecret.slice(0,24), iv_key);
        const secretData = {
          type: 'secret',
          iv_key: Array.from(iv_key),
          data: cipher.update(data, 'utf8', 'base64')
        };
        secretData.data += cipher.final('base64');
        data = JSON.stringify(secretData);
      }

      originalSend.call(socket, data);
    }
  })(socket.send);

  socket.requestStart = async function(data){
    if(this._callbacks[data.id] && this._callbacks[data.id].request) return;

    const compress = data.compress;

    this._callbacks[data.id] = {
      compress: data.compress
    };

    console.log(data.id, '> Start proxy url', (config.localServer || config.local) + data.url);
    console.debug(data.id, '> 2) Request start', data.url);
    
    let request = protocol.request((config.localServer || config.local) + data.url, {
      method: data.method,
      headers: data.headers,
      timeout: 20000
    });

    this._callbacks[data.id].partCb = part => request.write(part);
    this._callbacks[data.id].endCb = end => request.end();
    this._callbacks[data.id].destroyRequest = () => request.destroy();
    
    request.on('error', e=>{
      console.error('% Request err', e, data.url);
    });

    let response = await new Promise((ok, bad)=> request.on('response', resp=>ok(resp)));
    
    if(!this._callbacks[data.id]) return;
    
    this._callbacks[data.id].destroyResponse = ()=>response.destroy();

    console.debug(data.id, '> 7) response start', response.statusCode, response.headers);
    this.send({
      type: 'responseStart',
      id: data.id,
      code: response.statusCode,
      headers: response.headers,
    });

    // let chunks = Buffer.from('');
    let parts = 0;
    response.on('data', async chunk=>{
      if(!this._callbacks[data.id]) {
        return;
      }
      // chunks = Buffer.concat([chunks, chunk]);
      
      let partId = (Math.random()).toString(36);
      const socketData = {
        time: Date.now(),
        type: 'responsePart',
        id: data.id,
        partId
      }

      parts++;

      if(this._callbacks[data.id].compress == 'deflate') {
        chunk = zlib.deflateSync(chunk);
      }
      else if(this._callbacks[data.id].compress == 'gzip'){
        chunk = zlib.gzipSync(chunk);
      }
      else if(this._callbacks[data.id].compress == 'brotli'){
        chunk = zlib.brotliCompressSync(chunk);
      }

      socketData.body = chunk;

      console.debug(data.id, '> 9) response part', partId);
      this.send(socketData);
    });
    response.on('end', ()=>{
      if(!this._callbacks[data.id]) return;

      /*if(this._callbacks[data.id].compress == 'deflate') chunks = zlib.deflateSync(chunks);
      else if(this._callbacks[data.id].compress == 'gzip') chunks = zlib.gzipSync(chunks);
      else if(this._callbacks[data.id].compress == 'brotli') chunks = zlib.brotliCompressSync(chunks);*/

      console.debug(data.id, '> 11) response end');
      this.send({
        type: 'responseEnd',
        id: data.id,
        parts
        // body: chunks
      });
    });
  };
  socket.requestPart = function(data) {
    if(!data.id || !this._callbacks[data.id]){
      console.info(data.id, '% RequestPart - no such request id');
      return;
    }

    if(data.body && data.body.type == 'Buffer'){
      data.body = Buffer.from(data.body.data);
    }

    if(typeof data.body == 'object' && !Object.keys(data.body).length){
      data.body = '';
    }

    if(this._callbacks[data.id].compress == 'deflate') {
      data.body = zlib.inflateSync(data.body);
    }
    else if(this._callbacks[data.id].compress == 'gzip'){
      data.body = zlib.gunzipSync(data.body);
    }
    else if(this._callbacks[data.id].compress == 'brotli'){
      data.body = zlib.brotliDecompressSync(data.body);
    }

    console.debug(data.id, '> 4) requestPart send', data.partId);

    this._callbacks[data.id].partCb(data.body);
  }
  socket.requestEnd = function(data){
    if(!data.id || !this._callbacks[data.id]){
      console.info(data.id, '% 6) requestEnd - no such request id');
      return;
    }

    console.debug(data.id, '> 6) requestEnd end', data.partId);

    this._callbacks[data.id].endCb();
  };
  socket.cancelResponse = function(data) {
    if(this._callbacks[data.id].destroyRequest){
      console.debug(data.id, '% Destroy request');
      this._callbacks[data.id].destroyRequest();
    }

    if(this._callbacks[data.id].destroyResponse){
      console.debug(data.id, '% Destroy responce');
      this._callbacks[data.id].destroyResponse();
    }

    delete this._callbacks[data.id];
    /*this.send(JSON.stringify({
      type: 'responseEnd',
      id: data.id
    }));*/
  };

  socket.doping = function() {
    socket.send('ping');
    pingStart = Date.now();

    clearTimeout(socket.pingTimeout);

    socket.pingTimeout = setTimeout(()=>{
      console.warn('Close by timeout');
      socket.close(1001);
    }, 10000);
  };

  socket.on('open', ()=>{
    console.log('# Client socket to remote server opened');

    socket.doping();
  });

  socket.on('close', (code, reason)=>{
    let specificStatusCodeMappings = {
      '1000': 'Normal Closure',
      '1001': 'Going Away',
      '1002': 'Protocol Error',
      '1003': 'Unsupported Data',
      '1004': '(For future)',
      '1005': 'No Status Received',
      '1006': 'Abnormal Closure',
      '1007': 'Invalid frame payload data',
      '1008': 'Policy Violation',
      '1009': 'Message too big',
      '1010': 'Missing Extension',
      '1011': 'Internal Error',
      '1012': 'Service Restart',
      '1013': 'Try Again Later',
      '1014': 'Bad Gateway',
      '1015': 'TLS Handshake'
    };

    console.error('% Client socket closed', 'code:', code, 'reason:', reason, 'message', specificStatusCodeMappings[code]);

    if(code == 1016) return;

    if(code == 1006){
      return setTimeout(()=>{
        startTonel(config);
      }, 5000);
    }

    setTimeout(()=>{
      startTonel(config);
    }, 50);
  });
}