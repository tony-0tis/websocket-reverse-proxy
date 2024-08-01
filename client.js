const url = require('url');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const Stream = require('stream');
const websocket = require('ws');


let interval;
let pings = 0;

module.exports = config=>{
  require('./colorize')(console, config);
  console.warn('Start client');
  startTonel(config);
}

function startTonel(config){
  clearInterval(interval);

  let urlData = url.parse(config.localServer || config.local);
  let protocol = urlData.protocol == 'https:' ? https : http;
  let ECDHKey;
  let ECDHSecret;

  console.log('Open socket client connection:', (config.remoteServer || config.remote));
  let socket = new websocket(config.remoteServer || config.remote);
  socket.on('message', data=>{
    try{
      data = JSON.parse(data);
    }catch(e){}

    if(data.type == 'secret' && ECDHSecret){
      let cipher = crypto.createDecipheriv('aes-192-cbc', ECDHSecret.slice(0,24), new Uint8Array(data.iv_key));
      
      data = cipher.update(data.data, 'base64', 'utf8');
      data += cipher.final('utf8');
      
      try{
        data = JSON.parse(data);
      }catch(e){}
    }

    if(data.type == 'ECDH'){
      if(!ECDHKey){
        ECDHKey = crypto.createECDH('secp521r1');
        socket.send(JSON.stringify({type: 'ECDH', keys: ECDHKey.generateKeys()}));
      }
      
      ECDHSecret = ECDHKey.computeSecret(Buffer.from(data.keys.data));
      
      return;
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

    if(data.type == 'responseStartRecieved'){
      if(!socket._callbacks[data.id] || !socket._callbacks[data.id].parts['start']){
        return console.error(data.id, '% 7.1) responseStartRecieved - No callback for id');
      }

      console.debug(data.id, '< 7.1) responseStartRecieved');

      socket._callbacks[data.id].parts['start'].next();
      
      return;
    }
    if(data.type == 'responsePartRecieved'){
      if(!data.partId || !socket._callbacks[data.id] || !socket._callbacks[data.id].parts[data.partId]){
        return console.error(data.id, '% 9.1) responsePartRecieved - No callback for partId', data.partId);
      }

      console.debug(data.id, '< 9.1) responsePartRecieved');

      socket._callbacks[data.id].parts[data.partId].next();
      
      return;
    }
    if(data.type == 'responseEndRecieved'){
      if(!socket._callbacks[data.id] || !socket._callbacks[data.id].parts['end']){
        return console.error(data.id, '% 11.1) responseEndRecieved - No callback for id');
      }

      console.debug(data.id, '< 11.1) responseEndRecieved');

      socket._callbacks[data.id].parts['end'].next();

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
      if(ECDHSecret){
        let iv_key = crypto.randomFillSync(new Uint8Array(16));
        let cipher = crypto.createCipheriv('aes-192-cbc', ECDHSecret.slice(0,24), iv_key);
        
        data = {
          type: 'secret',
          iv_key: Array.from(iv_key),
          data: cipher.update(data, 'utf8', 'base64')
        };
        data.data += cipher.final('base64');
        data = JSON.stringify(data);
      }

      originalSend.call(socket, data);
    }
  })(socket.send);

  socket.sendWithCheck = function(partId, data, next){
    return new Promise((ok,bad)=>{
      this._callbacks[data.id].parts[partId] = {
        next(){
          clearInterval(this.si);
          delete socket._callbacks[data.id].parts[partId];
          
          next && next();
          
          ok();
        },
        si: setInterval(()=>{
          if(this._callbacks[data.id] && this._callbacks[data.id].parts[partId]){
            this._callbacks[data.id].parts[partId].count++;
            
            if(this._callbacks[data.id].parts[partId].count > 10) {
              clearInterval(this._callbacks[data.id].parts[partId].si);
            }
          }

          this.send(JSON.stringify(data))
        }, 1000)
      };

      this.send(JSON.stringify(data));
    });
  };

  socket.requestStart = async function(data){
    this.send(JSON.stringify({type: 'requestStartRecieved', id: data.id}));

    if(this._callbacks[data.id] && this._callbacks[data.id].request) return;

    this._callbacks[data.id] = {
      parts: {},
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

    let response = await new Promise((ok, bad)=>{
       request.on('response', resp=>ok(resp));
    });
    
    if(!this._callbacks[data.id]) return;
    
    this._callbacks[data.id].destroyResponse = ()=>response.destroy();

    response.pause();

    console.debug(data.id, '> 7) response start', response.statusCode, response.headers);
    await this.sendWithCheck('start', {
      type: 'responseStart',
      id: data.id,
      code: response.statusCode,
      headers: response.headers,
    });
    response.resume();

    // let chunks = Buffer.from('');
    response.on('data', async chunk=>{
      if(!this._callbacks[data.id]) {
        return;
      }
      // chunks = Buffer.concat([chunks, chunk]);

      response.pause();

      if(this._callbacks[data.id].compress == 'deflate') {
        chunk = zlib.deflateSync(chunk);
      }
      else if(this._callbacks[data.id].compress == 'gzip'){
        chunk = zlib.gzipSync(chunk);
      }
      else if(this._callbacks[data.id].compress == 'brotli'){
        chunk = zlib.brotliCompressSync(chunk);
      }

      console.debug(data.id, '> 9) response part');
      let partId = (Math.random()).toString(36);
      
      await this.sendWithCheck(partId, {
        type: 'responsePart',
        id: data.id,
        body: chunk,
        partId: partId
      });

      response.resume();
    });
    response.on('end', ()=>{
      if(!this._callbacks[data.id]) return;

      /*if(this._callbacks[data.id].compress == 'deflate') chunks = zlib.deflateSync(chunks);
      else if(this._callbacks[data.id].compress == 'gzip') chunks = zlib.gzipSync(chunks);
      else if(this._callbacks[data.id].compress == 'brotli') chunks = zlib.brotliCompressSync(chunks);*/

      console.debug(data.id, '> 11) response end');
      this.sendWithCheck('end', {
        type: 'responseEnd',
        id: data.id,
        // body: chunks
      });
    });
  };
  socket.requestPart = function(data) {
    this.send(JSON.stringify({type: 'requestPartRecieved', id: data.id, partId: data.partId}));

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
    this.send(JSON.stringify({type: 'requestEndRecieved', id: data.id}));

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

    if(this._callbacks[data.id].parts){
      for(let key in this._callbacks[data.id].parts){
        clearInterval(this._callbacks[data.id].parts[key].si);
      }
    }

    delete this._callbacks[data.id];
    /*this.send(JSON.stringify({
      type: 'responseEnd',
      id: data.id
    }));*/
  };

  socket.on('open', ()=>{
    console.log('# Client socket to remote server opened');

    interval = setInterval(()=>{
      pings++;
      if(pings >= 3) {
        pings = 0;
        socket.close(1001);
        clearInterval(interval);
        //socket.terminate();
        //startTonel(config);
        return;
      }

      socket.ping();
      //socket.send(JSON.stringify({type: 'ping'}));
    }, 1000);
  });

  socket.on('pong', data=>{
    // console.log('pong');
    pings--;
  });

  socket.on('error', e=>{
    console.error('% Client socket error', e);
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
    clearInterval(interval);

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

  socket.on('unexpected-response', (req, res)=>{
    console.error(req, res);
  });
}