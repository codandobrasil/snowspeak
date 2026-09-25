# SnowSpeak — Motor em tempo real (subprojeto 1)

Data: 2026-09-25
Status: arquitetura aprovada; revisão 2 do protocolo aguardando aprovação

## 1. Objetivo

Extensão do Chrome que, durante chamadas no navegador (Google Meet primeiro, mas qualquer aba), mostra em tempo real a legenda do que os outros participantes dizem em inglês com tradução para português do Brasil, e que, sob demanda, gera uma sugestão de resposta em inglês com tradução em português logo abaixo. Prioridade máxima: baixa latência.

SnowSpeak será vendido. Este documento cobre apenas o **subprojeto 1 (motor em tempo real)**, já preparado para múltiplos usuários e para medição de uso. Ficam para ciclos próprios, com spec e plano separados:

- Subprojeto 2 — contas e autenticação (login Google).
- Subprojeto 3 — cobrança e planos (Stripe / Mercado Pago / Pix), limites de uso, conciliação com faturas dos provedores.
- Subprojeto 4 — lançamento (landing page, política de privacidade/LGPD, Chrome Web Store).

### O que o usuário disse vs. premissas

Dito pelo usuário:
- Tradução EN → PT-BR em tempo real, o mais rápido possível.
- Sugestão de resposta em inglês com tradução em português abaixo.
- Extensão do Chrome, multiplataforma.
- Produto para vender.
- Cenários: relacionamento, trabalho/reuniões de equipe, vendas/atendimento, entrevistas de emprego.
- Sugestão **só sob demanda**.
- Transcrever **os dois lados** (aba + microfone do usuário).
- TypeScript em tudo.
- Arquitetura A: todo o áudio passa pelo backend.

Premissas adotadas:
- Provedores iniciais: Deepgram Nova-3 (STT streaming), DeepL (tradução), Claude Haiku 4.5 (sugestão). Todos atrás de interfaces trocáveis.
- Enquanto o subprojeto 2 não existe, o usuário se autentica com uma chave de acesso emitida manualmente.
- Backend hospedado nos EUA-leste, próximo ao Deepgram.

### Critérios de sucesso

| Métrica (p50, medida no servidor) | Meta |
|---|---|
| Frame de áudio → `transcript.partial` | < 500 ms |
| Fim de frase → `translation` | < 800 ms |
| `suggest.request` → primeiro `suggestion.delta` | < 1 s |

Além disso: sessão sobrevive a quedas de rede de até 60 s sem perder o histórico; nenhum segundo de áudio ou sugestão é cobrado duas vezes.

## 2. Funcionalidades do MVP

1. Usuário clica no ícone da extensão numa aba de chamada → abre o side panel.
2. No side panel escolhe o **modo** (Trabalho, Vendas, Entrevista, Relacionamento) e escreve um **contexto livre** (ex.: "sou dev backend, entrevista na empresa X"), até 2.000 caracteres.
3. Clica em Iniciar → captura da aba (canal `them`) e do microfone (canal `me`).
4. Legenda ao vivo:
   - Fala em andamento em cinza (parcial), trechos estáveis em branco.
   - Tradução PT-BR abaixo de cada frase do canal `them`.
   - Falas do canal `me` aparecem sem tradução, visualmente diferenciadas.
5. Botão "Sugerir resposta" ou atalho `Alt+S` → sugestão em inglês aparece em streaming, com a tradução em português abaixo. O botão fica desabilitado enquanto uma sugestão está sendo gerada.
6. Modo e contexto podem ser alterados durante a chamada; valem para as próximas sugestões.
7. Botão Parar encerra a sessão.

Fora do escopo do MVP: gravação de áudio, histórico persistente de conversas, exportar transcrição, outros pares de idiomas, apps desktop nativos, login, cobrança, múltiplas instâncias do backend.

## 3. Arquitetura

```
Aba (Meet/Zoom Web/...) ─tabCapture─┐
Microfone ─getUserMedia─────────────┤
                                    ▼
                    Offscreen document (dono da sessão no cliente)
                     AudioWorklet → PCM16 16kHz mono, frames ~100ms
                                    │ WebSocket (binário + JSON)
                                    ▼
                    Backend Node/TS (Fastify + ws), EUA-leste, 1 instância
                     gateway → session ─┬─ stt (Deepgram, 1 conexão/canal)
                                        ├─ translate (DeepL, só `them`)
                                        ├─ suggest (Claude Haiku 4.5)
                                        └─ metering (SQLite em disco persistente)
                                    │ eventos JSON
                                    ▼
                    Offscreen → chrome.runtime → Side panel (UI)
```

### 3.1 Estrutura do repositório (monorepo pnpm)

```
packages/shared/     tipos do protocolo, constantes, validadores
apps/extension/      extensão MV3 (Vite + TypeScript)
apps/server/         backend (Node + TypeScript, Fastify + ws)
```

### 3.2 Extensão (MV3)

| Unidade | Responsabilidade | Depende de |
|---|---|---|
| `service-worker` | Coordenador. Trata o clique no ícone, obtém `streamId` via `chrome.tabCapture.getMediaStreamId` (gesto do usuário, Chrome ≥ 116), cria/fecha o offscreen document, repassa comandos iniciar/parar. Não guarda estado de sessão; pode ser suspenso sem afetar a sessão. | APIs do Chrome |
| `offscreen/audio-capture` | Abre o stream da aba (a partir do `streamId`) e o do microfone. Reconecta o áudio da aba ao `AudioContext.destination` (a captura silencia a aba). AudioWorklet converte cada canal para PCM16 16 kHz mono em frames de ~100 ms e mantém o contador acumulado de samples por canal. | Web Audio |
| `offscreen/session-socket` | Um WebSocket com o backend. Envia frames binários (com descarte por congestionamento, §4.1), envia/recebe mensagens JSON, reconecta com backoff, executa a retomada, aplica a política de fechamento (§5.3). | `shared` |
| `offscreen/session-store` | **Fonte de verdade do cliente.** Aplica eventos do servidor em ordem de `seq`, trata replay e snapshot (§5.2), mantém as últimas ~200 falas, traduções, sugestão atual, `lastSeq` aplicado, `sessionId` e `resumeToken`. Responde a `snapshot` e publica eventos para o side panel. | `shared` |
| `sidepanel` | UI em modo somente exibição. Ao abrir, pede `snapshot` ao offscreen e depois assina os eventos. Pode fechar e reabrir sem perda. Contém seletor de modo, campo de contexto, iniciar/parar, legenda, botão de sugestão. | `chrome.runtime` |

Atalho `Alt+S` via `commands` no manifest → service worker → offscreen envia `suggest.request`.

### 3.3 Backend

| Módulo | Responsabilidade |
|---|---|
| `gateway` | Aceita WebSocket, valida `Origin`, exige a primeira mensagem de autenticação em 5 s, valida frames e mensagens, roteia para a `Session`. Garante um socket ligado por sessão e uma sessão ativa por conta. |
| `session` | Estado de uma chamada: modo, contexto, histórico das falas dos dois canais, buffer de eventos (500), `seq` de saída, `frameSeq` e `sampleOffset` esperados por canal, `resumeToken`, sugestão em andamento. Sem lógica de provedor. Vive 60 s após a queda do socket. |
| `utterance-assembler` | Converte os resultados do STT em `transcript.partial`, `transcript.segment` e exatamente um `utterance.end` por `utteranceId`; trata `UtteranceEnd` atrasado e fechamento forçado (§4.4). Puro, sem rede. |
| `sentence-splitter` | Acumula segmentos estáveis do canal `them` e decide quando uma frase está pronta para tradução (§4.5). Atribui `sentenceIdx` estável. Puro. |
| `audio-pipe` | Por canal: valida continuidade (`frameSeq`, `sampleOffset`), mantém fila limitada até o STT, descarta áudio velho, emite `audio.gap`, informa ao `metering` os samples cobráveis (§6). |
| `stt` | Interface `SttStream` (envia PCM, `finalize()`, emite resultados normalizados com tempos de palavra). Implementação `DeepgramStt` (Nova-3, `interim_results`, `smart_format`, `utterance_end_ms`, multilíngue no canal `me`). |
| `translate` | Interface `Translator.translate(text, ctx) → Promise<string>`. Implementação `DeepLTranslator` (EN → PT-BR). |
| `suggest` | Interface `Suggester.stream(prompt, signal) → AsyncIterable<{lang, text}>`. Implementação `ClaudeSuggester` (Haiku 4.5, streaming, prompt caching do system prompt por modo). `SuggestionRegistry` por sessão (§4.6). |
| `metering` | Contadores de samples cobráveis por `(sessionId, channel)` e sugestões por `requestId`; persiste com upsert idempotente (§6). |
| `metrics` | Latências por sessão (p50/p95); logs sem conteúdo da conversa. |

## 4. Protocolo

Versão `v: 1`. Tipos e validadores definidos em `packages/shared`.

### 4.1 Cliente → servidor: áudio (frame binário)

```
[canal: 1 byte (0 = them, 1 = me)]
[frameSeq: uint32 big-endian]
[sampleOffset: uint32 big-endian]   // samples capturados neste canal antes deste frame
[PCM16LE mono 16 kHz]
```

- Cabeçalho de 9 bytes. Payload PCM: tamanho par, 2 ≤ bytes ≤ 3.200 (100 ms). Frame total ≤ 3.209 bytes. Fora disso: frame descartado e contado em métrica de erro.
- `frameSeq` e `sampleOffset` começam em 0 por canal no início da sessão e avançam de forma independente em `them` e `me`. **Não zeram em reconexão.** `sampleOffset` avança por todo áudio capturado, inclusive o descartado pelo cliente.
- `uint32` de samples a 16 kHz cobre ~74 h; sessões têm duração máxima de 4 h (servidor encerra com `session.ended { reason: "max_duration" }`).
- Servidor aceita um frame apenas se `frameSeq` > último aceito naquele canal **e** `sampleOffset` ≥ próximo offset esperado.
- Duração do frame = bytes PCM / 2 / 16.000 s (o último frame pode ser menor).
- **Descarte por congestionamento no cliente**: antes de enviar, se `WebSocket.bufferedAmount` > 32 KB (~0,5 s de áudio dos dois canais), o frame é descartado em vez de enfileirado. O contador `sampleOffset` segue avançando, então o servidor mede a lacuna com exatidão.

### 4.2 Cliente → servidor: controle (JSON)

```ts
type ClientMessage =
  | { type: "session.start"; token: string; mode: Mode; context: string }
  | { type: "session.resume"; token: string; sessionId: string; resumeToken: string; lastSeq: number }
  | { type: "session.update"; mode?: Mode; context?: string }
  | { type: "suggest.request"; requestId: string }        // UUID gerado no clique
  | { type: "session.stop" };

type Mode = "work" | "sales" | "interview" | "relationship";
```

### 4.3 Servidor → cliente

As mensagens do servidor se dividem em **controle** (sem `seq`, nunca entram no buffer nem no replay) e **eventos** (com `seq`, entram no buffer de 500 e são reproduzidos na retomada).

**Mensagens de controle** — envelope `{ v: 1, type, sessionId }`:

| `type` | Campos extras | Significado |
|---|---|---|
| `session.started` | `resumeToken` | Sessão criada. |
| `session.resumed` | `strategy: "replay" \| "snapshot"`, `throughSeq` | Retomada aceita. `throughSeq` = último `seq` emitido pelo servidor no instante da retomada (§5.2). |
| `session.snapshot` | `snapshotSeq`, `state`, `gap: boolean`, `gapFromSeq?` | Estado completo equivalente a ter aplicado todos os eventos até `snapshotSeq`. |
| `session.superseded` | — | Outra conexão assumiu esta sessão. |
| `session.ended` | `reason: "stopped" \| "replaced" \| "expired" \| "max_duration" \| "error"` | Sessão encerrada. |

**Eventos** — envelope `{ v: 1, type, sessionId, seq, ts, channel?: "them" | "me", utteranceId?: string }`:

- `seq`: monotônico por sessão, começa em 1.
- `ts`: horário do servidor em ms.
- `utteranceId`: gerado pelo servidor, formato `${channel}-${n}`.

| `type` | Campos extras | Significado |
|---|---|---|
| `transcript.partial` | `text` | Texto provisório da fala atual (substitui o anterior). Nunca vira definitivo sozinho. |
| `transcript.segment` | `segmentIdx`, `text` | Trecho estável anexado à fala. |
| `utterance.end` | `interrupted: boolean` | Fala encerrada. Emitido **uma única vez** por `utteranceId`. `interrupted: true` = fechamento forçado (§4.4). |
| `translation` | `sentenceIdx`, `source`, `text` | Tradução PT-BR de uma frase do canal `them`. |
| `translation.error` | `sentenceIdx` | Frase fica só em inglês. |
| `suggestion.started` | `requestId`, `basedOnUtteranceId` | Geração iniciada. |
| `suggestion.delta` | `requestId`, `lang: "en" \| "pt"`, `text` | Pedaço da sugestão em streaming. |
| `suggestion.done` | `requestId`, `en`, `pt` | Sugestão completa e validada. |
| `suggestion.error` | `requestId`, `code: "busy" \| "rate_limited" \| "timeout" \| "invalid_output" \| "provider" \| "cancelled"` | Falha na sugestão. |
| `audio.gap` | `channel`, `durationMs`, `reason: "client_drop" \| "server_drop" \| "stt_unavailable"` | Áudio que não foi transcrito. Duração exata (derivada de `sampleOffset` ou dos samples descartados no servidor). |
| `error` | `scope: "stt" \| "translate" \| "suggest" \| "session"`, `code`, `retryable`, `message` | Erro exibível. |

**Códigos de fechamento do WebSocket** (a reação do cliente está em §5.3):

| Código | Motivo |
|---|---|
| `4400` | Retomada inválida ou violação de protocolo (ex.: `lastSeq` maior que o último `seq` emitido). |
| `4401` | Credencial ausente ou inválida. |
| `4404` | Sessão inexistente ou expirada. |
| `4409` | Sessão assumida por outra conexão. |
| `4410` | Sessão encerrada (`stopped`, `replaced`, `max_duration`). |

### 4.4 Montagem das falas

Regras do Deepgram:

- Resultado com `is_final=false` → `transcript.partial`.
- Resultado com `is_final=true` → `transcript.segment` (trecho estável; **não** significa fim de fala).
- `speech_final=true` ou mensagem `UtteranceEnd` → `utterance.end { interrupted: false }`. O primeiro que chegar fecha o `utteranceId`; o outro, referente à mesma fala, é ignorado.

**`UtteranceEnd` atrasado**: o assembler guarda, para cada fala, o tempo de início da primeira palavra (tempos do Deepgram). Um `UtteranceEnd` cujo `last_word_end` é anterior ao início da fala atual refere-se a uma fala já encerrada e é ignorado; ele nunca fecha a fala nova.

**Fechamento forçado** (queda do socket do cliente, falha do STT, `session.stop`):

1. O servidor pede finalização ao STT (`Finalize` do Deepgram) e aguarda até **500 ms** por resultados finais.
2. Segmentos estáveis recebidos nesse prazo são emitidos normalmente.
3. Se a fala não for encerrada pelo STT dentro do prazo, o servidor emite `utterance.end { interrupted: true }`.
4. O texto parcial pendente é **descartado**, nunca promovido a segmento. A UI mostra os segmentos estáveis e um marcador "fala interrompida".
5. Uma fala interrompida sem nenhum segmento estável é removida da UI.

### 4.5 Tradução

Somente canal `them`. O `sentence-splitter` envia uma frase para tradução quando:

1. o texto acumulado contém um fim de frase (`.`, `?`, `!`) vindo do `smart_format`; ou
2. passaram **2,5 s** desde o primeiro segmento pendente sem pontuação; ou
3. o texto pendente atinge **30 palavras**; ou
4. chega `utterance.end` (envia o restante, inclusive em fala interrompida).

`sentenceIdx` é atribuído pelo servidor em ordem dentro de cada `utteranceId` e nunca muda, mesmo que cheguem novos segmentos. Traduções podem chegar fora de ordem; o cliente ordena por `(utteranceId, sentenceIdx)`.

### 4.6 Sugestão sob demanda

Ao receber `suggest.request { requestId }`, o servidor avalia nesta ordem:

1. **Duplicado**: `requestId` já conhecido nesta sessão →
   - em andamento: o socket atual passa a receber os deltas restantes (o texto já gerado está no snapshot/replay);
   - concluído: reenvia o `suggestion.done` armazenado;
   - com erro: reenvia o `suggestion.error` armazenado.
   Duplicados nunca são afetados pelos limites abaixo.
2. **Uma geração por sessão**: se outra sugestão está em andamento → `suggestion.error { code: "busy" }`.
3. **Frequência**: menos de 2 s desde o último pedido aceito → `suggestion.error { code: "rate_limited" }`.
4. **Congelamento**: modo, contexto e as últimas ~20 falas finalizadas (rótulos `THEM:`/`ME:`) são copiados neste instante. `session.update` posterior afeta apenas sugestões futuras.
5. Emite `suggestion.started`, chama o Claude (system prompt fixo por modo, cacheado) com saída no formato `<en>…</en><pt>…</pt>`, converte em `suggestion.delta`.
6. **Validação**: ao final, ambos os blocos `<en>` e `<pt>` devem existir e ser não vazios. Caso contrário → `suggestion.error { code: "invalid_output" }`.
7. Sucesso → `suggestion.done { requestId, en, pt }`.

Timeout de 15 s → `suggestion.error { code: "timeout" }`. Ao encerrar a sessão (qualquer motivo), gerações pendentes são canceladas via `AbortSignal` → `suggestion.error { code: "cancelled" }`.

O snapshot inclui a sugestão em andamento com o texto EN e PT já gerado, para que o painel reaberto ou o cliente retomado continue exibindo-a.

## 5. Autenticação, retomada e concorrência

### 5.1 Autenticação

- O WebSocket abre sem credenciais na URL.
- `Origin` deve ser `chrome-extension://<id da extensão>`; caso contrário a conexão é recusada.
- A primeira mensagem deve ser `session.start` ou `session.resume` em até 5 s; senão, fechamento `4401`.
- `token` é a chave de acesso do usuário (no subprojeto 2 passará a ser um token do login Google).

### 5.2 Retomada

- `session.started` entrega um `resumeToken` (256 bits aleatórios, ligado a `sessionId` + usuário). **No MVP o `resumeToken` é fixo durante toda a sessão**; a retomada exige também `token` válido do mesmo usuário. Rotação com confirmação fica para depois.
- `lastSeq` = último evento efetivamente **aplicado** pelo `session-store` do cliente.
- O servidor valida:
  - `token` inválido → fechamento `4401`;
  - sessão inexistente/expirada ou `resumeToken` incorreto → `4404`;
  - `lastSeq` > último `seq` emitido → `4400`.
- Seja `throughSeq` o último `seq` emitido no instante da retomada e `firstBuffered` o menor `seq` no buffer:
  - **Replay** (`lastSeq ≥ firstBuffered − 1`): envia `session.resumed { strategy: "replay", throughSeq }` e em seguida os eventos `lastSeq+1 … throughSeq`, em ordem. Eventos novos (`seq > throughSeq`) vêm depois.
  - **Snapshot** (`lastSeq < firstBuffered − 1`): envia `session.resumed { strategy: "snapshot", throughSeq }` e em seguida `session.snapshot { snapshotSeq: throughSeq, state, gap: true, gapFromSeq: lastSeq + 1 }`.
- Cliente:
  - Em `strategy: "snapshot"`, retém eventos recebidos até chegar o `session.snapshot`; substitui o estado, define `lastSeq = snapshotSeq`, mostra marcador de intervalo perdido e então aplica os eventos retidos com `seq > snapshotSeq`.
  - Em qualquer estratégia, eventos com `seq ≤ lastSeq` são ignorados (idempotência) e um salto de `seq` fora do replay é tratado como erro de protocolo (reconecta pedindo retomada).
- Sessão sem socket por mais de 60 s → `expired`; transcrições apagadas da memória.

### 5.3 Reação do cliente a cada fechamento

| Situação | Reação do cliente |
|---|---|
| Queda de rede / fechamento sem código de aplicação | Reconecta com backoff 0,5 s → 1 s → 2 s → 4 s → 8 s → 10 s (máx.), por até 60 s, via `session.resume`. |
| `4401` credencial inválida | **Para as reconexões automáticas.** Mostra "Chave de acesso inválida" e campo para reinserir. |
| `4404` sessão expirada | Mostra "Sessão expirada" e oferece "Iniciar nova sessão" (mesmo modo e contexto); o histórico anterior fica visível, marcado como encerrado. |
| `4400` retomada inválida | Descarta o estado de retomada e se comporta como `4404`. |
| `4409` sessão substituída | **Para as reconexões automáticas** (evita dois clientes se substituindo em ciclo). Mostra "Sessão aberta em outro lugar" com botão "Usar aqui", que faz uma retomada manual. |
| `4410` / `session.ended` | Para as reconexões; mostra o motivo. |

### 5.4 Áudio durante quedas e congestionamento

- Enquanto o socket está fechado ou congestionado (§4.1), o cliente descarta os frames; `frameSeq` e `sampleOffset` continuam avançando.
- Ao receber um frame com `sampleOffset` maior que o esperado, o servidor emite `audio.gap { reason: "client_drop", durationMs }` com a duração exata ((`sampleOffset` − esperado) / 16).
- Na queda do socket, o servidor aplica o fechamento forçado das falas (§4.4) e fecha as conexões STT; reabre ao retomar.

### 5.5 Conexões concorrentes

- **Um socket ligado por sessão.** Uma retomada válida assume a sessão; o socket anterior recebe `session.superseded` e é fechado com `4409`. Frames e mensagens que ainda chegarem pelo socket antigo são descartados (e `frameSeq`/`sampleOffset` monotônicos impedem aceitação dupla).
- **Uma sessão ativa por conta.** Um `session.start` com sessão ativa encerra a anterior com `session.ended { reason: "replaced" }` e fecha seu socket com `4410`.

## 6. Pipeline de áudio no servidor e medição de uso

### 6.1 Fila até o STT

- Cada canal tem uma fila limitada a **1 s** de áudio entre o `audio-pipe` e a conexão STT.
- Se a fila excede 1 s (STT lento), os frames mais antigos são descartados → `audio.gap { reason: "server_drop" }`.
- Enquanto a conexão STT está reconectando, frames recebidos são descartados → `audio.gap { reason: "stt_unavailable" }`. Não há reenvio de áudio velho ao STT.

### 6.2 Ponto de contabilização

**Definição operacional**: um sample é cobrável quando pertence a um frame aceito pelas regras de §4.1 e foi **escrito numa conexão STT no estado aberto, com o callback de envio do WebSocket concluído sem erro**. É nesse callback que o `metering` soma os samples.

Não contam: frames descartados pelo cliente, rejeitados pelo servidor, descartados da fila, enviados durante reconexão do STT ou cujo envio falhou.

**Limitação registrada**: a confirmação do transporte não prova que o provedor transcreveu aquele áudio. A conciliação com o consumo reportado pelo Deepgram fica para o subprojeto 3.

### 6.3 Persistência

- Contadores em memória por `(sessionId, channel)`, em samples, gravados a cada 10 s, no fim da sessão e no `SIGTERM` (desligamento gracioso), com **upsert** (`samples = valor acumulado atual`), portanto regravar é seguro.
- **Sugestões**: uma linha por `requestId` com restrição `UNIQUE`; conta apenas `suggestion.done`. Canceladas, com timeout ou `invalid_output` não contam.
- Tabelas: `usage_audio(session_id, user_id, channel, samples, updated_at)` PK `(session_id, channel)`; `usage_suggestion(request_id PK, session_id, user_id, created_at)`.
- SQLite via camada de repositório que permita trocar por Postgres.

### 6.4 Limites de infraestrutura do MVP

- **Uma única instância** do backend, com SQLite em **disco persistente**.
- Sessões e buffers de retomada vivem na memória dessa instância: **um reinício encerra todas as sessões** (clientes recebem `4404` e iniciam nova sessão).
- Uma queda abrupta do processo (sem `SIGTERM`) pode perder até 10 s de consumo ainda não persistido.
- Múltiplas instâncias exigirão estado de sessão compartilhado ou afinidade de conexão — fora do escopo do MVP.

## 7. Erros e UI

| Falha | Servidor | UI |
|---|---|---|
| Queda da conexão STT | Fechamento forçado das falas (§4.4); reconecta até 3× com backoff; áudio no intervalo → `audio.gap stt_unavailable`, não cobrado. | Faixa amarela "Transcrição instável"; após 3 falhas, vermelha "Transcrição parada" + botão Reiniciar. |
| Tradução | 1 nova tentativa; depois `translation.error`. | Frase só em inglês com ícone "tradução indisponível". |
| Sugestão | `suggestion.error` com `code`. | `busy`: botão já desabilitado; `rate_limited`: aguarda; demais: mensagem + "Tentar de novo" (novo `requestId`). |
| Microfone negado | Sessão só com canal `them`. | Aviso "Sugestões sem suas falas". |
| Áudio perdido | `audio.gap`. | Marcador "⚠ trecho não transcrito (X s)". |
| Fechamentos `44xx` | Ver §4.3. | Ver §5.3. |

## 8. Privacidade e segurança

- Chaves de Deepgram, DeepL e Anthropic somente no servidor.
- Áudio nunca é gravado em disco.
- Transcrições apenas em memória; apagadas no fim da sessão (após a carência de 60 s).
- Logs com métricas, códigos de erro e IDs; nunca o conteúdo da conversa.
- Validação de `Origin`, de tamanho e continuidade de frames e de todas as mensagens JSON (schemas em `shared`).
- Limites: `context` ≤ 2.000 caracteres; uma sugestão em andamento por sessão; 1 pedido de sugestão aceito a cada 2 s; sessão ≤ 4 h.

## 9. Testes

- **Unitários (Vitest)**, sem rede:
  - `utterance-assembler`: `is_final` vs `speech_final` vs `UtteranceEnd`; um único `utterance.end` quando ambos chegam; **`UtteranceEnd` atrasado da fala anterior chegando depois de uma nova fala começar** (não fecha a fala nova); fechamento forçado com e sem finais dentro de 500 ms; parcial nunca promovido; fala interrompida sem segmentos.
  - `sentence-splitter`: pontuação, limite de 2,5 s (relógio falso), limite de 30 palavras, `sentenceIdx` estável, restante no `utterance.end`.
  - Frames: tamanhos válidos/inválidos, frame final curto, duração calculada, dedup de `frameSeq`, `sampleOffset` retroativo rejeitado, gap exato por `sampleOffset`.
  - `audio-pipe`: fila de 1 s com descarte dos mais antigos, descarte durante STT indisponível, samples cobráveis só no callback de sucesso.
  - Buffer e retomada: replay dentro do buffer, snapshot fora do buffer com `snapshotSeq`, `lastSeq` maior que o emitido → `4400`, eventos de controle fora da sequência.
  - `SuggestionRegistry`: duplicado em andamento/concluído/com erro antes dos limites, `busy`, `rate_limited`, congelamento do contexto após `session.update`, `invalid_output`, cancelamento no fim da sessão.
  - Metering: upsert idempotente, unicidade por `requestId`, flush no `SIGTERM`.
  - Cliente `session-store`: aplicação ordenada, ignorar `seq ≤ lastSeq`, retenção de eventos até o snapshot, snapshot com sugestão em andamento.
  - Cliente `session-socket`: tabela de reações de §5.3 (sem reconexão em `4401`/`4409`), descarte por `bufferedAmount`.
- **Integração**: servidor real com `FakeStt`, `FakeTranslator`, `FakeSuggester` reproduzindo sequências gravadas do Deepgram; cliente WebSocket de teste cobrindo início, queda, retomada por replay, retomada por snapshot, socket substituído, sessão substituída, expiração, reinício do servidor.
- **Ponta a ponta opcional** (`E2E_PROVIDERS=1`): arquivo de áudio em inglês pelos provedores reais, validando as metas de latência.
- **Manual no Chrome**: roteiro no plano (ver §10).

## 10. Ordem de implementação (orientação para o plano)

1. **Marco 1 — validação no Chrome, sem provedores**: clique no ícone → side panel → Iniciar → permissão do microfone → captura dos dois canais (medidores de nível na UI e frames chegando a um servidor com STT falso) → áudio da aba continua audível → fechar e reabrir o painel preserva o estado. Nenhuma integração com Deepgram/DeepL/Claude antes deste marco passar.
2. Marco 2 — protocolo completo com provedores falsos: sessão, retomada, concorrência, metering, testes de integração.
3. Marco 3 — Deepgram (transcrição ao vivo dos dois canais).
4. Marco 4 — DeepL (tradução por frase).
5. Marco 5 — Claude (sugestão sob demanda) e medição de latência.

## 11. Decisões registradas

| Decisão | Motivo |
|---|---|
| Todo áudio pelo backend (abordagem A) | Chaves protegidas, cobrança medida no servidor, troca de provedor sem atualizar a extensão. |
| Offscreen document como dono da sessão | O service worker do MV3 pode ser suspenso; o side panel pode fechar. |
| Controle separado de eventos com `seq` | Evita contradição de ordem na retomada; só eventos entram no replay. |
| `resumeToken` fixo no MVP | Rotação sem confirmação pode perder a sessão se a conexão cair na troca. |
| `sampleOffset` no frame | Mede lacunas de áudio com exatidão, independentemente do tamanho dos frames. |
| Descartar áudio velho (cliente e servidor) | Reenviar ou enfileirar atrasaria a legenda ao vivo; o usuário vê o marcador de trecho não transcrito. |
| Parcial nunca vira definitivo | Texto provisório pode estar errado; fechamento forçado preserva só segmentos estáveis. |
| Uma sugestão em andamento por sessão | Evita gerações simultâneas e custo duplicado; UI desabilita o botão. |
| Sugestão só sob demanda | Escolha do usuário; controla custo de LLM. |
| Saída `<en>…</en><pt>…</pt>` | Mais simples de processar em streaming que JSON. |
| DeepL para tradução | Latência baixa e boa qualidade em PT-BR; trocável por Claude via interface. |
| Uma instância + SQLite persistente | Suficiente para o MVP; limites documentados em §6.4. |
