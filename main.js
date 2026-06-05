async function loadScript(src) {
  return new Promise(function (resolve, reject) {
    var script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.onload = function () {
      resolve();
    };
    script.onerror = function () {
      reject(new Error('Nao foi possivel carregar ' + src));
    };
    document.head.appendChild(script);
  });
}

async function bootstrap() {
  var scripts = [
    '/vendor/angular.min.js',
    './lib/karaoke-settings.js',
    './lib/karaoke-core.js',
    './app.js',
  ];

  for (var index = 0; index < scripts.length; index += 1) {
    await loadScript(scripts[index]);
  }
}

bootstrap().catch(function (error) {
  window.console.error(error);
});
