process.on('uncaughtException', err => {
  console.error(`Caught exception: ${err}\n${err.stack}`);
});

module.exports = config => {
  console.log('#Configuration to start:', config);

  require('./colorize')(console, config);

  if(config.type == 'client'){
    console.warn('Start client');
    require('./client')(config);
  }
  else{
    console.warn('Start server');
    require('./server')(config);
  }
};

module.exports.server = (config, apiKey) => {
  if(typeof config === 'number'){
    config = {port: config, apiKey};
  }
  module.exports({...config, ...{type: 'server'}});
};

module.exports.client = (config, remote, apiKey) => {
  if(typeof config !== 'object'){
    config = {local: config, remote, apiKey};
  }
  module.exports({...config, ...{type: 'client'}});
};


const config = {};
for(let i = 2; i < process.argv.length; i++){
  let [key, value] = process.argv[i].split('=');
  config[key] = value;
}

if(config.run == 'wrp'){
  module.exports(config);
}


function init() {}

function createECDH(ECDHKey, socket) {
  if(!ECDHKey){
    ECDHKey = crypto.createECDH('secp521r1');
    socket.send(JSON.stringify({type: 'ECDH', keys: ECDHKey.generateKeys()}));
  }
  
  return {
    ECDHKey, 
    ECDHSecret: ECDHKey.computeSecret(Buffer.from(data.keys.data))
  };
}