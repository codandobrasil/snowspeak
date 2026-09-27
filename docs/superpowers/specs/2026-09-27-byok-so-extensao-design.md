# SnowSpeak só-extensão com as chaves do usuário (BYOK) — design

Data: 2026-09-27 · Branch: `feat/byok`

## Objetivo

Publicar o SnowSpeak na Chrome Web Store como uma extensão que funciona sozinha, sem servidor. Cada usuário cola a própria chave do Deepgram (obrigatória) e, se quiser sugestões, a própria chave do OpenRouter. O dono do projeto não paga API nem hospedagem, e as chaves ficam só no Chrome do usuário.

**Público:** pessoas que sabem gerar uma chave de API e colá-la na ferramenta.

**Sucesso:**
- Legenda, tradução e sugestões funcionam como hoje (marcos 3, 4 e 5), só com as chaves digitadas no painel.
- Nenhuma requisição sai para outro destino além de `api.deepgram.com` e `openrouter.ai`.
- Existe um pacote `.zip` pronto para envio à loja, com política de privacidade, textos e ícones.

**Fora do escopo:** cobrança, conta de usuário, medição de uso, outros provedores, suporte a outros navegadores. O envio à loja (conta de desenvolvedor, taxa, formulário) fica com o usuário.

## Viabilidade (spike de 2026-09-27)

WebSocket do padrão web (Node 20 `--experimental-websocket`, mesmo handshake do Chrome) em `wss://api.deepgram.com/v1/listen` com `new WebSocket(url, ["token", chave])`: o Deepgram devolveu o subprotocolo `token` (sem isso o navegador derrubaria a conexão), abriu em ~0,9 s e transcreveu uma fala gerada pelo TTS dele próprio (parciais + final + `Metadata` + fechamento 1000). O código do spike foi descartado.

## Arquitetura

Antes: painel → service worker → offscreen (captura) → **WebSocket para o servidor** → servidor (pipeline, Deepgram, OpenRouter) → eventos de volta ao offscreen → store → painel.

Depois: painel → service worker → offscreen (captura **e motor**) → Deepgram / OpenRouter direto do offscreen → eventos → store → painel.

```
offscreen
 ├─ capture (tab + mic)  ──PCM──▶  LocalSession (packages/engine)
 │                                   ├─ ChannelPipeline them ─▶ Deepgram (WebSocket do navegador)
 │                                   ├─ ChannelPipeline me   ─▶ Deepgram
 │                                   └─ SuggestionEngine     ─▶ OpenRouter (fetch em streaming)
 └─ SessionController ◀── eventos (mesmo formato de hoje) ──┘  → SessionStore → TranslationQueue → painel
```

### Abordagem escolhida: o controlador chama o motor direto

O `SessionController` passa a usar um `LocalSession` em memória, em vez de um socket. Tudo o que existia só por causa da rede sai: `session.resume`, `resumeToken`, buffer de reposição, heartbeat, `CLOSE_CODES`, codificação binária dos frames, o timer de silêncio do servidor e a reconexão do socket.

Alternativa descartada: manter o controlador intacto e entregar a ele um "socket falso" ligado a uma `Session` local. Mexe menos agora, mas mantém centenas de linhas de retomada que nunca rodariam, e continua testando um protocolo de rede que não existe mais.

A reconexão continua existindo, mas **no nível do stream do Deepgram** (ver "Erros e reconexão").

## Pacotes e módulos

### `packages/engine` (novo)

Recebe do `apps/server/src` os módulos que já são puros, com os testes deles:

| Módulo | Origem |
|---|---|
| `utterance-assembler`, `sentence-splitter`, `channel-sequencer`, `forward-clock`, `latency`, `channel-pipeline` | `apps/server/src/` |
| `stt/types`, `stt/deepgram-messages` | `apps/server/src/stt/` |
| `suggest/prompt`, `suggest/question-detector`, `suggest/tag-stream`, `suggest/suggestion-engine`, `suggest/openrouter` | `apps/server/src/suggest/` |

Novos:
- **`stt/deepgram-browser.ts`**: o cliente Deepgram reescrito para o `WebSocket` do navegador. Mantém a URL e os parâmetros de hoje (`deepgramListenUrl`), o KeepAlive a cada 4 s, o descarte acima de 32 KB em `bufferedAmount`, os até 10 frames pendentes enquanto abre, o prazo de 5 s para abrir, `Finalize` e `CloseStream`. A autenticação vai no subprotocolo `["token", chave]`, e `terminate()` vira `close()`. O construtor do `WebSocket` é injetável para os testes.
- **`local-session.ts`**: a `Session` do servidor sem dono, sem buffer, sem retomada e sem `node:crypto` (usa `crypto.randomUUID()`). Recebe `sttFactory`, `suggester | null` e as configurações. Emite as mensagens pelo callback `onMessage`: `session.started` ao iniciar, `session.ended` ao encerrar e os eventos com `seq` no envelope de hoje. API: `start(): Promise<void>` (resolve quando o STT do canal `them` abre; rejeita se a primeira abertura falhar), `acceptFrame(frame)`, `update(changes)`, `requestSuggestion(requestId, question?)`, `beginStop()`, `drain()`, `close(reason)`.
- **`suggest/openrouter.ts`** ajustado para o navegador: lê o corpo com `response.body.getReader()` em vez de iteração assíncrona (o manifesto aceita Chrome 116). O cabeçalho `X-Title: SnowSpeak` continua. Sai o `createFakeSuggester`.

Saem sem substituto: `gateway`, `session-registry`, `event-buffer`, `config`, `providers`, `main`, `tone-page`, `stt/fake-stt`, `stt/signal-probe`, `test-support/test-client` e os testes de gateway e retomada.

### `packages/shared`

Continua com `audio-frame` (o tipo `AudioFrame`, `SAMPLE_RATE`, `frameSamples`, `samplesToMs`) e `messages`. Em `messages` ficam só os tipos que o motor emite e o store consome. Saem as mensagens do cliente (`ClientMessage`, `parseClientMessage`), `session.resumed`, `session.superseded`, `heartbeat`, `CLOSE_CODES`, o `resumeToken` de `session.started`, `encodeFrame` e `decodeFrame`. Os nomes `ServerMessage` e `ServerEvent` passam a `EngineMessage` e `EngineEvent`, porque "servidor" deixaria de ser verdade. Os validadores zod de mensagens recebidas saem, porque as mensagens não cruzam mais uma fronteira não confiável. `zod` sai das dependências se nada mais o usar.

### `apps/server`

Removido da árvore. Continua no histórico do git (último commit com o servidor: `0706794`). O `.env` local não é versionado; o usuário decide se apaga.

### `apps/extension`

- **`offscreen/session-controller.ts`**: sem socket. `start` captura a aba e o microfone (como hoje), cria o `LocalSession` com as chaves de `StartParams` e espera `session.start()`. Se o Deepgram recusar a primeira conexão, a sessão falha com "Não foi possível conectar ao Deepgram. Confira a chave em Configurações." e libera a captura. Os frames vão direto a `session.acceptFrame`, montados como `AudioFrame` por um contador por canal (o `FrameSender` vira esse contador, sem `bufferedAmount`). Parar chama `beginStop`, libera a captura, espera `drain()` com o limite de 3 s de hoje, fecha e despacha `stopped`. Microfone desligado, fim da captura da aba e `update` seguem como hoje.
- **`offscreen/socket.ts`**: removido.
- **`offscreen/session-store.ts`**: sem `resumeToken` e sem o status/ação `reconnecting` da conexão com o servidor. Ganha o aviso da reconexão do Deepgram (ver abaixo). Também ganha `suggestionsEnabled`, falso quando não há chave do OpenRouter.
- **`messaging.ts`**: `StartParams` troca `serverUrl` e `token` por `deepgramKey`, `openRouterKey` (pode ser vazia) e `suggestionModel`.
- **Painel**: ver "Configurações".
- **Manifesto**: ver "Loja".

## Configurações

Na seção Configurações do painel, no lugar de "Servidor" e "Chave de acesso":

- **Chave do Deepgram** (`password`, obrigatória), com link "Onde gerar" para `console.deepgram.com`.
- **Chave do OpenRouter** (`password`, opcional), com link para `openrouter.ai/keys` e a dica "Sem ela, a legenda funciona, mas não há sugestões de resposta."
- **Modelo das sugestões** (texto, padrão `anthropic/claude-haiku-4.5`). Campo vazio volta ao padrão.
- **Botão "Testar chaves"**: roda os testes no próprio painel e mostra o resultado de cada chave ("Deepgram: ok", "OpenRouter: chave recusada", "OpenRouter: não configurada").
  - Deepgram: `GET https://api.deepgram.com/v1/projects` com `Authorization: Token <chave>`. 200 é ok, 401/403 é chave recusada, o resto é falha de rede ou do provedor.
  - OpenRouter: `GET https://openrouter.ai/api/v1/key` com `Authorization: Bearer <chave>`. Mesma leitura.
  - As duas funções ficam num módulo puro (`sidepanel/key-check.ts`) com `fetch` injetável.

Regras:
- As chaves ficam em `chrome.storage.local` (`deepgramKey`, `openRouterKey`, `suggestionModel`). Nunca vão para `chrome.storage.sync`, logs, mensagens de erro ou URLs.
- Na primeira abertura depois da atualização, o painel apaga `serverUrl` e `token` antigos do storage.
- **Iniciar** sem chave do Deepgram mostra "Informe a chave do Deepgram em Configurações." e não inicia a captura.
- Sem chave do OpenRouter, o motor roda sem `SuggestionEngine`: não há sugestão automática, o botão/atalho de sugerir fica desabilitado, e o clique numa pergunta não faz nada. O cartão de sugestão mostra "Sugestões desligadas: informe a chave do OpenRouter."
- O texto de privacidade do painel passa a dizer: "Suas chaves, currículo e vaga ficam só neste navegador. O áudio vai direto ao Deepgram; a conversa, o currículo e a vaga vão direto ao OpenRouter apenas para gerar sugestões."
- Mudar chave ou modelo durante uma sessão vale para a próxima sessão.

## Erros e reconexão

**Deepgram, na abertura.** O primeiro stream do canal `them` não abre em 5 s ou fecha antes de abrir: a sessão falha (mensagem acima). O navegador não informa o status HTTP do handshake, então chave errada e rede fora aparecem iguais; o botão "Testar chaves" é o jeito de distinguir. Se só o canal `me` falhar na abertura, a sessão segue e ele entra em reconexão.

**Deepgram, no meio da sessão.** Quando um stream que já abriu cai, o `ChannelPipeline`:
1. fecha a fala aberta como interrompida (como hoje);
2. emite `stt.status { channel, state: "reconnecting" }`;
3. tenta abrir um stream novo após 0,5, 1, 2, 4, 8 e 10 s (e depois a cada 10 s), por até 60 s contados da queda. Enquanto isso, o áudio recebido é descartado e contado como `audio.gap` com motivo `stt_unavailable`. A linha do tempo recomeça (`ForwardClock` novo e `assembler.resetTimeline()`, como no `reopenStt` de hoje), e os ids de falas e frases seguem a numeração;
4. quando reabre, emite `stt.status { channel, state: "ok" }`;
5. passados 60 s sem conseguir, emite o `error` `stt_connection_lost` de hoje e para de tentar naquele canal. A sessão continua; o outro canal não é afetado.

O store mostra "Reconectando ao Deepgram…" enquanto algum canal está em `reconnecting` e apaga o aviso quando os dois voltam a `ok`. Isso também resolve o problema adiado do marco 2, em que o aviso "transcrição parou" ficava na tela depois da retomada.

**OpenRouter.** Continuam os erros de sugestão de hoje (`timeout`, `provider`, `invalid_output`, `busy`, `rate_limited`, `cancelled`). Um 401 ou 403 do OpenRouter vira o novo código `unauthorized` em `SUGGESTION_ERROR_CODES`, e o cartão diz "O OpenRouter recusou a chave. Confira em Configurações." Os outros status continuam como `provider`.

**Offscreen fechado pelo Chrome.** Nada muda: o documento vive enquanto há captura, como hoje.

## Loja (Chrome Web Store)

- **Manifesto:** `permissions` = `tabCapture`, `offscreen`, `sidePanel`, `activeTab`, `storage`. `host_permissions` = `https://api.deepgram.com/*`, `https://openrouter.ai/*`. O `activeTab` continua porque o clique no ícone autoriza a captura da aba. O WebSocket do Deepgram não precisa de permissão de host; os `fetch` (teste de chaves e sugestões) precisam. A versão vai para `0.2.0`, com `icons` e `action.default_icon`.
- **Ícones:** PNG 16, 32, 48 e 128 px, gerados a partir de um SVG versionado em `apps/extension/public/icons/`.
- **Política de privacidade:** `docs/loja/politica-de-privacidade.md`, em português e inglês. Diz o que sai do navegador (áudio para o Deepgram; transcrição, modo, contexto, currículo e vaga para o OpenRouter), que tudo vai com a chave do próprio usuário, que o desenvolvedor não recebe nada, e que as chaves ficam em `chrome.storage.local`. A política precisa de uma URL pública; o usuário escolhe onde publicar (ex.: GitHub Pages ou Gist público), porque o repositório é privado.
- **Textos da loja:** `docs/loja/listagem.md` com nome, resumo (≤132 caracteres), descrição, justificativa de cada permissão e respostas do formulário de práticas de dados.
- **Screenshots:** 1280×800. O usuário tira no Chrome dele; `docs/loja/listagem.md` lista quais telas mostrar.
- **Pacote:** script `pnpm --filter @snowspeak/extension package`, que faz o build e gera `apps/extension/snowspeak-<versão>.zip` a partir de `dist/`. O `.zip` fica no `.gitignore`.

## Testes

- Os testes dos módulos migrados vão junto para `packages/engine`, com os imports ajustados. Os testes de `session-transcription` e `session-suggestions` são adaptados ao `LocalSession`, e os de gateway e retomada saem.
- `deepgram-browser.test.ts`: `WebSocket` falso cobrindo o subprotocolo com a chave, a URL, os pendentes enquanto abre, o descarte por `bufferedAmount`, o KeepAlive, o prazo de abertura, `Finalize` e `CloseStream`, e erro depois de `close()` sem callback.
- `channel-pipeline.test.ts`: reconexão com timers falsos (sequência de esperas, `stt.status`, `audio.gap` durante a queda, desistência em 60 s, falas seguindo a numeração).
- `local-session.test.ts`: `start` resolve e rejeita, `session.started`/`session.ended`, sem suggester, e Parar esvaziando as falas.
- `session-controller.test.ts`: reescrito para o motor falso (início, falha do Deepgram na abertura, Parar, fim da captura da aba, microfone desligado).
- `session-store.test.ts`: `stt.status` e aviso, `suggestionsEnabled`.
- `key-check.test.ts`: `fetch` falso cobrindo 200, 401, erro de rede e chave vazia.
- Roteiro manual no README, "BYOK — roteiro de validação": instalar o zip sem compactação, sem chave, chave errada, "Testar chaves", sessão com e sem OpenRouter, derrubar a rede por ~10 s no meio da sessão (reconexão), derrubar por mais de 60 s, Parar, e conferir em `chrome://extensions` → Detalhes que só aparecem os dois hosts. Também uma chamada real do Google Meet.
- `pnpm test` e `pnpm typecheck` verdes. O README perde as instruções do servidor e ganha as de chave.

## Ordem de execução

1. `packages/engine`: mover os módulos e testes, adaptar o `openrouter` ao navegador e criar `deepgram-browser` e `local-session`.
2. Reconexão do Deepgram no `ChannelPipeline` e o evento `stt.status`.
3. Extensão: controlador sem socket, store, `messaging`, poda do `shared`.
4. Configurações no painel e teste de chaves.
5. Remover `apps/server` e atualizar o README com o roteiro.
6. Loja: manifesto, ícones, política, listagem e script do zip.

Cada etapa termina com `pnpm test` e `pnpm typecheck` verdes. A validação no Chrome acontece depois da etapa 4 e de novo depois da 6.
