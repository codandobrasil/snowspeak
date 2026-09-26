# SnowSpeak

Legendas EN→PT-BR em tempo real e sugestões de resposta para chamadas no navegador.

- Spec: `docs/superpowers/specs/2026-09-25-snowspeak-realtime-engine-design.md`
- Planos: `docs/superpowers/plans/` (marco 1, marcos 3 e 4, marco 5)

## Requisitos

- Node 20+
- pnpm 9 (`corepack prepare pnpm@9.15.9 --activate`)
- Google Chrome 116+

## Desenvolvimento

```bash
pnpm install
pnpm test
pnpm --filter @snowspeak/extension build
```

1. Abra `chrome://extensions`, ative o **Modo do desenvolvedor**, clique em **Carregar sem compactação** e escolha `apps/extension/dist`.
2. Copie o ID da extensão exibido no card.
3. `cp apps/server/.env.example apps/server/.env` e preencha `ALLOWED_ORIGINS=chrome-extension://<ID>` e uma chave em `ACCESS_KEYS`.
   Para transcrição real, preencha também `DEEPGRAM_API_KEY` (console.deepgram.com → API Keys; a conta nova vem com crédito). Sem ela, o servidor usa o STT falso e avisa no log. A tradução não precisa de chave: roda no próprio Chrome (Translator API, Chrome 138+ para desktop).
   Para sugestões de resposta reais, preencha `OPENROUTER_API_KEY` (openrouter.ai → Keys); o modelo fica em `SUGGESTION_MODEL` (padrão `anthropic/claude-haiku-4.5`). Sem a chave, o servidor usa sugestões falsas e avisa no log.
4. `pnpm --filter @snowspeak/server dev`
5. Na aba que você quer capturar, clique no ícone do SnowSpeak. O painel abre associado **a essa aba**. Informe a chave e clique em **Iniciar**.

Depois de mudar o código da extensão: `pnpm --filter @snowspeak/extension build` e clique em recarregar no card da extensão.

### O que o painel mostra

**Com `DEEPGRAM_API_KEY`:** a legenda da conversa. O inglês aparece enquanto a pessoa fala (em cinza enquanto é provisório), o português aparece em verde abaixo de cada frase dos participantes, e as suas falas aparecem em roxo, sem tradução. Na primeira sessão, o Chrome pode baixar o modelo de tradução (há um botão para seguir só em inglês enquanto isso).

**Sem a chave:** o STT falso do marco 1, que mede o áudio recebido e mostra por canal:

```
[fake-stt them] 12.0 s · -9 dBFS · ~440 Hz
```

- **duração**: segundos de áudio aceitos pelo servidor;
- **nível** em dBFS e **frequência dominante**: confirmam que o PCM chegou correto;
- `silêncio` quando o nível fica abaixo de -60 dBFS.

A página `http://localhost:8787/tone` toca um seno de 440 Hz com amplitude 0,5 (≈ -9 dBFS), útil para conferir o caminho do áudio sem provedores.

## Marco 1 — roteiro de validação

Marque cada item ao validar no Chrome:

- [x] Clicar no ícone abre o painel lateral.
- [x] "Liberar microfone" abre a aba de permissão; depois de aceitar, o aviso some do painel.
- [x] Abrir `http://localhost:8787/tone`, clicar em **Tocar**, clicar no ícone do SnowSpeak nessa aba e em **Iniciar**: o status muda para "Capturando" e a barra "Participantes" se move.
- [x] O tom continua audível durante a captura.
- [x] O canal Participantes mostra **≈ -9 dBFS · ~440 Hz**, com a duração crescendo 1 s por segundo.
- [x] Parar o tom na página: o canal passa a mostrar `silêncio`.
- [x] Falar no microfone move a barra "Você" e mostra nível e frequência no canal Você.
- [x] "descartados" e "s perdidos" ficam em 0 na rede local.
- [x] Fechar e reabrir o painel durante a captura mostra o mesmo status, contadores e textos.
- [x] **Parar**: status "Parado", barras zeradas e o indicador de captura da aba some.
- [x] **Parar durante a inicialização** (clicar Iniciar e logo em seguida Parar): nada fica capturando e é possível iniciar de novo.
- [x] **Fechar a aba capturada** durante a sessão: o painel mostra "A captura da aba terminou (aba fechada ou compartilhamento encerrado)." e nada fica capturando.
- [x] Com o painel aberto, trocar para outra aba (sem clicar no ícone nela) e clicar em Iniciar: aparece "Clique no ícone do SnowSpeak nesta aba para autorizar a captura." e nenhuma aba é capturada.
- [x] Chave errada: mensagem "Chave de acesso inválida." e nada fica capturando.
- [x] Servidor desligado: "Não foi possível conectar ao servidor." e nada fica capturando.
- [x] Servidor cai no meio da sessão: "Conexão com o servidor encerrada (código 1006)." e a captura é liberada (reconexão fica para o marco 2).
- [x] Endereço inválido no campo Servidor (ex.: `http://x`): mensagem de endereço inválido, sem iniciar a captura.
- [x] Microfone bloqueado (configurações do site da extensão → bloquear microfone): a sessão inicia e aparece "Sugestões sem suas falas".
- [x] Clique duplo rápido em Iniciar: uma única captura (os contadores não duplicam).
- [x] Com alto-falantes (sem fone), tocando o tom: anotar se o canal Você mostra ~440 Hz (eco da aba no microfone). Isso é informação para o marco 3. Resultado: sem eco.
- [x] Repetir o fluxo numa chamada real do Google Meet.

Se aparecer "Extension has not been invoked for the current page" ao iniciar, anote: é o caso previsto na contingência R7 do plano (o clique no ícone passa a iniciar a sessão diretamente).

## Marcos 3 e 4 — roteiro de validação (com a chave do Deepgram)

- [x] O log do servidor mostra `STT: Deepgram · tradução: no Chrome do usuário`.
- [x] Na primeira vez, Iniciar mostra "Baixando o tradutor do Chrome… X%" (só se o modelo ainda não estiver instalado), com o botão "Continuar só em inglês".
- [x] Numa aba com um vídeo em inglês (entrevista, podcast), o inglês aparece enquanto a pessoa fala, primeiro em cinza (parcial) e depois firme.
- [x] O português aparece abaixo de cada frase logo depois que ela termina.
- [x] A tradução soa como português do Brasil natural (anotar exemplos bons e ruins).
- [x] Fala longa sem pausa: a tradução aparece aos poucos (a cada frase ou a cada ~2,5 s), sem esperar o fim.
- [x] Falando no microfone (inglês ou português), a fala aparece como "Você", sem tradução.
- [x] Clicar em Parar no meio de uma frase: status "Finalizando…", as últimas palavras aparecem e são traduzidas, depois "Parado".
- [x] Parar durante o download do tradutor cancela o início.
- [x] Fechar e reabrir o painel mantém a legenda.
- [x] Chave do Deepgram errada (troque no `.env` e reinicie o servidor): aparece "A transcrição parou…" e a sessão segue capturando.
- [x] Ao parar, o log do servidor mostra a latência estimada do STT (`latência estimada do STT (segmento final) p50 …`).
- [ ] Repetir numa chamada real do Google Meet.

## Marco 5 — roteiro de validação (com a chave do OpenRouter)

- [x] O log do servidor mostra `sugestões: OpenRouter (anthropic/claude-haiku-4.5)`.
- [x] Nas configurações, preencher o currículo e a vaga e escolher o modo Entrevista (os campos ficam salvos).
- [x] Num vídeo de entrevista em inglês, quando a entrevistadora termina uma pergunta, a sugestão aparece sozinha em ~1–2 s no rodapé: curta, em inglês, com o português abaixo.
- [x] A sugestão usa o currículo (cita experiência real) e não inventa empresas ou números.
- [x] O botão "Sugerir resposta" e o atalho Alt+S pedem uma sugestão a qualquer momento.
- [x] Apertar Alt+S várias vezes rápido: aparece um aviso curto e fica uma sugestão só.
- [x] Duas perguntas seguidas: fica a sugestão da última.
- [x] Chave do OpenRouter errada (troque no `.env` e reinicie o servidor): o cartão mostra "serviço de IA indisponível" e a legenda segue normal.
- [x] Parar durante uma sugestão: nada fica gerando.
- [x] **Limpar** apaga a legenda e a sugestão prontas; a fala em andamento continua.
- [x] Durante a captura, a legenda aparece em duas colunas: Entrevistador à esquerda; Você e as sugestões à direita, na ordem da conversa.
- [x] A sugestão aparece logo abaixo da pergunta a que responde, e essa pergunta fica marcada.
- [x] Clicar numa pergunta já terminada do entrevistador (ou Tab + Enter) pede a resposta para ela, mesmo depois de a conversa seguir.
- [x] Com o painel estreito, os blocos ocupam quase toda a largura, encostados no seu lado.
- [ ] Repetir numa chamada real do Google Meet.
