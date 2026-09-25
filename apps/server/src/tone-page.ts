// Página de validação manual: toca um seno conhecido para conferir o áudio capturado de ponta a ponta.
export const TONE_PAGE_HTML = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <title>SnowSpeak — tom de teste</title>
    <style>
      body { font: 16px system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1rem; }
      button { font: inherit; padding: 8px 16px; margin-right: 8px; }
    </style>
  </head>
  <body>
    <h1>Tom de teste: 440 Hz</h1>
    <p>Toca um seno de 440 Hz com amplitude 0,5. Ao capturar esta aba, o SnowSpeak deve mostrar
      <strong>≈ -9 dBFS · ~440 Hz</strong> no canal Participantes, com a duração crescendo 1 s por segundo.</p>
    <p><button id="play">Tocar</button><button id="stop" disabled>Parar</button></p>
    <script>
      let context = null;
      const play = document.getElementById("play");
      const stop = document.getElementById("stop");
      play.onclick = () => {
        context = new AudioContext();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.frequency.value = 440;
        gain.gain.value = 0.5;
        oscillator.connect(gain).connect(context.destination);
        oscillator.start();
        play.disabled = true;
        stop.disabled = false;
      };
      stop.onclick = () => {
        context?.close();
        context = null;
        play.disabled = false;
        stop.disabled = true;
      };
    </script>
  </body>
</html>
`;
