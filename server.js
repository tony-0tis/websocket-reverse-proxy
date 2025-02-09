const zlib = require('zlib');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const websocket = require('ws');

module.exports = config=>{
  let remoteSocket = null;
  let protocol = config.protocol == 'https' ? https : http;
  let options = config.serverOptions || {};

  const server = protocol.createServer(options);

  server.on('request', (request, response)=>{
    if(!remoteSocket) {
      response.writeHead(503, 'No connection yet');
      return response.end(`
        <div style="height: 100%;display: flex;justify-content: center;align-items: center;font-size: 120%;font-family: serif;font-weight: bold;">
          ${config.noConnectionErrorMessage || 'No connection yet.'}
        </div>
      `);
    }

    remoteSocket.processRequest(request, response);
  });
  server.listen(config.port || 1080, ()=>{
    console.log('# Socket and http servers started on port', config.port || 1080);
  });

  const wss = new websocket.Server({server});
  wss.on('connection', ws=>{
    console.log('# Websocket connected');
    if(!config.apikey){
      remoteSocket = iniSocket(ws, config);
    }
    else{
      ws.send(JSON.stringify({type: 'auth'}));
    }

    ws.on('close', (code, reason)=>{
      console.log('# Websocket closed', code, reason, new Error().stack);
      if(typeof code != 'number') code = 1001;
      if(typeof reason == 'undefined') reason = 'closed';
      
      if(ws){
        ws.close(code, reason);
      }
      ws = null;
    });

    ws.on('message', data=>{
      try{
        data = JSON.parse(data);
      }catch(e){}

      if(config.apikey && data.type == 'auth'){
        if(data.apikey == config.apikey){
          if(remoteSocket && remoteSocket.readyState === websocket.OPEN){
            remoteSocket.close(1016, 'new connection');
          }

          remoteSocket = iniSocket(ws, config);
        }
        else{
          ws.send(JSON.stringify({error: 'wrong auth'}));
        }
      }
    });

    process.on('exit', (code)=>{
      console.log('close socket by process exit', code);
      ws.close(1001);
    });
  });
};

function iniSocket(socket, config) {
  let ECDHKey;
  let ECDHSecret;
  if(config.ECDH){
    ECDHKey = crypto.createECDH('secp521r1');
    socket.send(JSON.stringify({type: 'ECDH', keys: ECDHKey.generateKeys()}));
  }
  else{
    socket.send(JSON.stringify({type: 'connected'}));
  }

  console.log('# RemoteSocket setted');
  socket.on('message', data=>{
    try{
      data = JSON.parse(data);
    }catch(e){}

    if(data === 'ping'){
      socket.send('pong');
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

      data = cipher.update(data.data, 'base64', 'utf8')
      data += cipher.final('utf8');

      try{
        data = JSON.parse(data);
      }catch(e){}
    }

    if(data.type == 'responseStart'){
      socket.responseStart(data);
      return;
    }

    if(data.type == 'responsePart'){
      socket.responsePart(data);
      return;
    }

    if(data.type == 'responseEnd'){
      socket.responseEnd(data);
      return;
    }

    console.warn('resend message', data);
    socket.send(JSON.stringify(data));
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

  socket.processRequest = async function(request, response) {
    let id = (Math.random()).toString(36);

    console.log(id, '> New url to obtain', request.url);

    response.on('close', ()=>{
      this.cancelResponse(id);
    });
    
    this._callbacks[id] = {
      id: id,
      canceled: false,
      startCb: start=>response.writeHead(start.code, start.headers),
      partCb: part=>response.write(part),
      endCb: end=>response.end(),
    };
    if(config.processRequestTimeout > 0){
       this._callbacks[id].si = setTimeout(()=>{
        this.cancelResponse(id);
      }, config.processRequestTimeout || 120000);
    }

    console.debug(id, '> 1) Init request', request.url);
    this.send({
      type: 'requestStart',
      id: id,
      url: request.url,
      method: request.method,
      headers: request.headers,
      compress: config.compress
    });

    let parts = 0;
    request.on('data', async chunk=>{
      if(!this._callbacks[id]) {
        return;
      }

      let partId = (Math.random()).toString(36);
      const socketData = {
        type: 'requestPart',
        id: id,
        partId: partId
      }

      parts++;

      if(config.compress == 'deflate') chunk = zlib.deflateSync(chunk);
      else if(config.compress == 'gzip') chunk = zlib.gzipSync(chunk);
      else if(config.compress == 'brotli') chunk = zlib.brotliCompressSync(chunk); 

      socketData.body = chunk;

      console.debug(id, '> 3) Request part', partId);
      this.send(socketData);
    });
    request.on('end', ()=>{
      if(!this._callbacks[id]) {
        return;
      }

      console.debug(id, '> 5) Request end');
      this.send({
        type: 'requestEnd',
        id: id
      });
    });
  };
  socket.responseStart = function(data) {
    if(!data || !data.id || !this._callbacks[data.id]){
      console.info(data.id, '8) % ResponseStart - no such response id');
      return;
    }

    console.debug(data.id, '< 8) Start to return(headers)');
    this._callbacks[data.id].startCb(data);
  };
  socket.responsePart = function(data){
    if(!data.id || !this._callbacks[data.id]){
      console.info(data.id, '% 10) ResponsePart - no such response id');
      return;
    }

    if(data.body && data.body.type == 'Buffer'){
      data.body = Buffer.from(data.body.data);
    }
    if(typeof data.body == 'object' && !Object.keys(data.body).length || !data.body){
      data.body = '';
    }

    if(config.compress == 'deflate') data.body = zlib.inflateSync(data.body);
    else if(config.compress == 'gzip') data.body = zlib.gunzipSync(data.body);
    else if(config.compress == 'brotli') data.body = zlib.brotliDecompressSync(data.body);

    console.debug(data.id, '< 10) Part to return:', data.partId);
    this._callbacks[data.id].partCb(data.body);
  };
  socket.responseEnd = function(data){
    if(!data.id || !this._callbacks[data.id]){
      console.info(data.id, '% 12) ResponseEnd - no such response id');
      return;
    }

    if(data.body){
      if(data.body && data.body.type == 'Buffer'){
        data.body = Buffer.from(data.body.data);
      }
      if(typeof data.body == 'object' && !Object.keys(data.body).length){
        data.body = '';
      }

      if(config.compress == 'deflate') data.body = zlib.inflateSync(data.body);
      else if(config.compress == 'gzip') data.body = zlib.gunzipSync(data.body);
      else if(config.compress == 'brotli') data.body = zlib.brotliDecompressSync(data.body);
      this._callbacks[data.id].partCb(data.body);
    }

    console.debug(data.id, '< 12) End to return');
    this._callbacks[data.id].endCb(data);
    
    this.cancelResponse(data.id);
  };
  socket.cancelResponse = function(id){
    if(!this._callbacks[id]){
      //console.debug('% CancelResponse - no such response id', id);
      return;
    }

    console.debug(id, '< Cancel response');

    this.send(JSON.stringify({type: 'cancelResponse', id: id}));
    
    clearInterval(this._callbacks[id].si);
    delete this._callbacks[id];
  };
  return socket;
}