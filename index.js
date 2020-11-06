process.on('uncaughtException', err=>{
  console.error(`Caught exception: ${err}\n${err.stack}`);
});

module.exports = config=>{
  console.log('#Configuration to start:', config);

  if(config.type == 'client'){
    require('./client')(config);
  }
  else{
    require('./server')(config);
  }
};


let config = {};
for(let i=2;i<process.argv.length;i++){
  let [key, value] = process.argv[i].split('=');
  config[key] = value;
}
if(config.run == 'wrp'){
  module.exports(config);
}
