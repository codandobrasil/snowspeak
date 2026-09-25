export {}; // torna o arquivo um módulo (await no nível superior)

const status = document.getElementById("status") as HTMLParagraphElement;

try {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) track.stop();
  status.textContent = "Microfone liberado. Esta aba vai fechar sozinha.";
  setTimeout(() => window.close(), 1_000);
} catch {
  status.textContent = "Permissão negada. O SnowSpeak vai funcionar só com o áudio da chamada.";
}
