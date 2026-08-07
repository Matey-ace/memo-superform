(function () {
  var MAP = {
    'heatmap':   { gif: 'img/gifs/soyo-bighead.gif', fb: '\uD83D\uDD25' },
    'trend':     { gif: 'img/gifs/taki-daze.gif',    fb: '\uD83D\uDCC8' },
    'memory':    { gif: 'img/gifs/soyo-shy.gif',     fb: '\uD83E\uDDE0' },
    'aiclass':   { gif: 'img/gifs/nyamu-shout.gif',  fb: '\uD83E\uDD16' },
    'diary':     { gif: 'img/gifs/umiri-happy.gif',  fb: '\uD83D\uDCD4' },
    'study-web': { gif: 'img/gifs/anon-think.gif',   fb: '\uD83D\uDCD6' },
    'notepad':   { fb: '\uD83D\uDCDA' },
    'growth':    { fb: '\uD83D\uDCCA' },
    'recommend': { fb: '\uD83C\uDFAF' }
  };

  function apply() {
    document.querySelectorAll('.tile').forEach(function (tile) {
      var sel = tile.querySelector('.chart-selector');
      var icon = tile.querySelector('.tile-icon');
      if (!sel || !icon) return;
      var m = MAP[sel.value] || {};
      var content = m.gif
        ? '<img class="tile-icon-gif" src="' + m.gif + '" alt="">'
        : m.fb || '';
      if (icon.innerHTML !== content) icon.innerHTML = content;
    });
  }

  document.querySelectorAll('.chart-selector').forEach(function (s) {
    s.addEventListener('change', function () { setTimeout(apply, 0); });
  });

  if (document.readyState === 'loading') {
    // 等 App.init()（同步重设图标）跑完后再应用 GIF
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(apply, 0);
      setTimeout(apply, 400);
    });
  } else {
    apply();
    setTimeout(apply, 400);
  }
})();