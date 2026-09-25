# SnowSpeak — Motor em tempo real (subprojeto 1)

Data: 2026-09-25
Status: aprovado em conversa; aguardando revisão do documento escrito

## 1. Objetivo

Extensão do Chrome que, durante chamadas no navegador (Google Meet primeiro, mas qualquer aba), mostra em tempo real a legenda do que os outros participantes dizem em inglês com tradução para português do Brasil, e que, sob demanda, gera uma sugestão de resposta em inglês com tradução em português logo abaixo. Prioridade máxima: baixa latência.

SnowSpeak será vendido. Este documento cobre apenas o **subprojeto 1 (motor em tempo real)**, já preparado para múltiplos usuários e para medição de uso. Ficam para ciclos próprios, com spec e plano separados:

- Subprojeto 2 — contas e autenticação (login Google).
- Subprojeto 3 — cobrança e planos (Stripe / Mercado Pago / Pix), limites de uso.
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
2. No side panel escolhe o **modo** (Trabalho, Vendas, Entrevista, Relacionamento) e escreve um **contexto livre** (ex.: "sou dev backend, entrevista na empresa X").
3. Clica em Iniciar → captura da aba (canal `them`) e do microfone (canal `me`).
4. Legenda ao vivo:
   - Fala em andamento em cinza (parcial), trechos estáveis em branco.
   - Tradução PT-BR abaixo de cada frase do canal `them`.
   - Falas do canal `me` aparecem sem tradução, visualmente diferenciadas.
5. Botão "Sugerir resposta" ou atalho `Alt+S` → sugestão em inglês aparece em streaming, com a tradução em português abaixo.
6. Botão Parar encerra a sessão.

Fora do escopo do MVP: gravação de áudio, histórico persistente de conversas, exportar transcrição, outros pares de idiomas, apps desktop nativos, login, cobrança.

## 3. Arquitetura

```
Aba (Meet/Zoom Web/...) ─tabCapture─┐
Microfone ─getUserMedia─────────────┤
                                    ▼
                    Offscreen document (dono da sessão no cliente)
                     AudioWorklet → PCM16 16kHz mono, frames ~100ms
                                    │ WebSocket (binário + JSON)
                                    ▼
                    Backend Node/TS (Fastify + ws), EUA-leste
                     gateway → session ─┬─ stt (Deepgram, 1 conexão/canal)
                                        ├─ translate (DeepL, só `them`)
                                        ├─ suggest (Claude Haiku 4.5)
                                        └─ metering (SQLite/Postgres)
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
| `offscreen/audio-capture` | Abre o stream da aba (a partir do `streamId`) e o do microfone. Reconecta o áudio da aba ao `AudioContext.destination` (a captura silencia a aba). AudioWorklet converte cada canal para PCM16 16 kHz mono em frames de ~100 ms. | Web Audio |
| `offscreen/session-socket` | Um WebSocket com o backend. Envia frames binários, envia/recebe mensagens JSON, reconecta com backoff, executa a retomada. | `shared` |
| `offscreen/session-store` | **Fonte de verdade do cliente.** Aplica eventos do servidor em ordem de `seq`, mantém as últimas ~200 falas, traduções, sugestão atual, `lastSeq` aplicado, `sessionId` e `resumeToken`. Responde a `snapshot` e publica eventos para o side panel. | `shared` |
| `sidepanel` | UI em modo somente exibição. Ao abrir, pede `snapshot` ao offscreen e depois assina os eventos. Pode fechar e reabrir sem perda. Contém seletor de modo, campo de contexto, iniciar/parar, legenda, botão de sugestão. | `chrome.runtime` |

Atalho `Alt+S` via `commands` no manifest → service worker → offscreen envia `suggest.request`.

### 3.3 Backend

| Módulo | Responsabilidade |
|---|---|
| `gateway` | Aceita WebSocket, valida `Origin`, exige a primeira mensagem de autenticação em 5 s, valida frames, roteia para a `Session`. Garante um socket ligado por sessão e uma sessão ativa por conta. |
| `session` | Estado de uma chamada: modo, contexto, histórico das falas dos dois canais, buffer de eventos (500), `seq` de saída, `frameSeq` aceito por canal, `resumeToken`. Sem lógica de provedor. Vive 60 s após a queda do socket. |
| `utterance-assembler` | Converte os resultados do STT em `transcript.partial`, `transcript.segment` e exatamente um `utterance.end` por `utteranceId`. Puro, sem rede. |
| `sentence-splitter` | Acumula segmentos finais do canal `them` e decide quando uma frase está pronta para tradução (pontuação, 2,5 s ou 30 palavras, `utterance.end`). Atribui `sentenceIdx` estável. Puro. |
| `stt` | Interface `SttStream` (envia PCM, emite resultados normalizados). Implementação `DeepgramStt` (Nova-3, `interim_results`, `smart_format`, `utterance_end_ms`, multilíngue no canal `me`). |
| `translate` | Interface `Translator.translate(text, ctx) → Promise<string>`. Implementação `DeepLTranslator` (EN → PT-BR). |
| `suggest` | Interface `Suggester.stream(prompt) → AsyncIterable<{lang, text}>`. Implementação `ClaudeSuggester` (Haiku 4.5, streaming, prompt caching do system prompt por modo). Registro de gerações por `requestId`. |
| `metering` | Conta segundos aceitos e encaminhados ao STT por canal e sugestões por `requestId`; persiste com upsert idempotente. |
| `metrics` | Latências por sessão (p50/p95); logs sem conteúdo da conversa. |

## 4. Protocolo

Versão `v: 1`. Tipos definidos em `packages/shared`.

### 4.1 Cliente → servidor: áudio (frame binário)

```
[canal: 1 byte (0 = them, 1 = me)][frameSeq: uint32 big-endian][PCM16LE mono 16 kHz]
```

- Payload PCM: tamanho par, 2 ≤ bytes ≤ 3.200 (100 ms). Frame total ≤ 3.205 bytes. Fora disso: frame descartado e contado em métrica de erro.
- `frameSeq` começa em 0 por canal no início da sessão e avança de forma independente em `them` e `me`. **Não zera em reconexão.**
- Servidor aceita um frame apenas se `frameSeq` > último aceito naquele canal.
- Duração do frame = bytes PCM / 2 / 16.000 s (o último frame pode ser menor).

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

### 4.3 Servidor → cliente: eventos (JSON)

Envelope comum:

```ts
{ v: 1, type, sessionId, seq, ts, channel?: "them" | "me", utteranceId?: string }
```

- `seq`: monotônico por sessão, começa em 1.
- `ts`: horário do servidor em ms.
- `utteranceId`: gerado pelo servidor, formato `${channel}-${n}`.

| `type` | Campos extras | Significado |
|---|---|---|
| `session.started` | `resumeToken` | Sessão criada. |
| `session.resumed` | `resumeToken` | Retomada aceita; seguem eventos com `seq > lastSeq`. |
| `session.snapshot` | `state`, `gap: boolean`, `gapFromSeq?` | Estado completo; `gap: true` indica intervalo irrecuperável. |
| `transcript.partial` | `text` | Texto provisório da fala atual (substitui o anterior). |
| `transcript.segment` | `segmentIdx`, `text` | Trecho estável anexado à fala. |
| `utterance.end` | — | Fala encerrada. Emitido **uma única vez** por `utteranceId`. |
| `translation` | `sentenceIdx`, `source`, `text` | Tradução PT-BR de uma frase do canal `them`. |
| `translation.error` | `sentenceIdx` | Frase fica só em inglês. |
| `suggestion.delta` | `requestId`, `lang: "en" \| "pt"`, `text` | Pedaço da sugestão em streaming. |
| `suggestion.done` | `requestId`, `en`, `pt`, `basedOnUtteranceId` | Sugestão completa. |
| `suggestion.error` | `requestId`, `code` | Falha na sugestão. |
| `audio.gap` | `channel`, `durationMs` | Áudio perdido durante queda. |
| `error` | `scope: "stt" \| "translate" \| "suggest" \| "session"`, `code`, `retryable`, `message` | Erro exibível. |
| `session.superseded` | — | Outra conexão assumiu esta sessão. |
| `session.ended` | `reason: "stopped" \| "replaced" \| "expired" \| "error"` | Sessão encerrada. |

### 4.4 Montagem das falas (regras do Deepgram)

- Resultado com `is_final=false` → `transcript.partial`.
- Resultado com `is_final=true` → `transcript.segment` (trecho estável; **não** significa fim de fala).
- `speech_final=true` ou mensagem `UtteranceEnd` → `utterance.end`. O primeiro que chegar fecha o `utteranceId`; o outro, referente à mesma fala, é ignorado. O próximo segmento abre um novo `utteranceId`.

### 4.5 Tradução

Somente canal `them`. O `sentence-splitter` envia uma frase para tradução quando:

1. o texto acumulado contém um fim de frase (`.`, `?`, `!`) vindo do `smart_format`; ou
2. passaram **2,5 s** desde o primeiro segmento pendente sem pontuação; ou
3. o texto pendente atinge **30 palavras**; ou
4. chega `utterance.end` (envia o restante).

`sentenceIdx` é atribuído pelo servidor em ordem dentro de cada `utteranceId` e nunca muda, mesmo que cheguem novos segmentos. Traduções podem chegar fora de ordem; o cliente ordena por `(utteranceId, sentenceIdx)`.

### 4.6 Sugestão sob demanda

- Cliente gera `requestId` (UUID) no clique e envia `suggest.request`.
- Prompt: system prompt fixo por modo (cacheado) + contexto do usuário + últimas ~20 falas finalizadas dos dois canais, rotuladas `THEM:`/`ME:`.
- Claude responde no formato `<en>…</en><pt>…</pt>`; o servidor converte em `suggestion.delta` com `lang` e, ao fim, `suggestion.done`.
- Idempotência por `requestId`:
  - pedido novo → inicia geração;
  - pedido repetido **durante** a geração → o socket atual passa a receber os deltas restantes da geração existente (sem nova chamada ao Claude);
  - pedido repetido **após** a conclusão → reenviado `suggestion.done` armazenado.
- Timeout de 15 s → `suggestion.error`.

## 5. Autenticação, retomada e concorrência

### 5.1 Autenticação

- O WebSocket abre sem credenciais na URL.
- `Origin` deve ser `chrome-extension://<id da extensão>`; caso contrário a conexão é recusada.
- A primeira mensagem deve ser `session.start` ou `session.resume` em até 5 s; senão, fechamento `4401`.
- `token` é a chave de acesso do usuário (no subprojeto 2 passará a ser um token do login Google).

### 5.2 Retomada

- `session.started` e `session.resumed` entregam um `resumeToken` (256 bits aleatórios, ligado a `sessionId` + usuário).
- `session.resume` exige `token` válido **e** `resumeToken` corrente. Cada retomada bem-sucedida gera um `resumeToken` novo; o anterior deixa de valer. Falha → fechamento `4403`; o cliente inicia sessão nova.
- `lastSeq` = último evento do servidor efetivamente **aplicado** pelo `session-store` do cliente.
- Se `lastSeq` ≥ primeiro `seq` do buffer − 1 → servidor envia `session.resumed` e reproduz os eventos com `seq > lastSeq`.
- Se `lastSeq` é anterior ao buffer → servidor envia `session.resumed` seguido de `session.snapshot { gap: true, gapFromSeq }`; o cliente substitui seu estado pelo snapshot e mostra um marcador de intervalo perdido.
- Cliente reconecta com backoff 0,5 s → 1 s → 2 s → 4 s → 8 s → 10 s (máximo), por até 60 s.
- Sessão sem socket por mais de 60 s → `expired`; transcrições apagadas da memória.

### 5.3 Áudio durante a queda

- Áudio capturado enquanto o socket está fechado é **descartado** no cliente (reenviar atrasaria todas as legendas seguintes). O `frameSeq` continua avançando durante o descarte.
- O servidor detecta o salto de `frameSeq` e emite `audio.gap { channel, durationMs }`; a UI mostra "⚠ trecho perdido (Xs)".
- Na queda, o servidor encerra a fala em andamento como está (`utterance.end`) e fecha as conexões STT; reabre ao retomar.

### 5.4 Conexões concorrentes

- **Um socket ligado por sessão.** Uma retomada válida assume a sessão; o socket anterior recebe `session.superseded` e é fechado com `4409`. Frames e mensagens que ainda chegarem pelo socket antigo são descartados (e o `frameSeq` monotônico impede aceitação dupla).
- **Uma sessão ativa por conta.** Um `session.start` com sessão ativa encerra a anterior com `session.ended { reason: "replaced" }`.

## 6. Medição de uso (cobrança)

- **Áudio**: segundos = soma das durações dos frames aceitos (regra do `frameSeq`) **e** entregues com sucesso ao STT. Frames descartados, duplicados ou não entregues ao STT não contam.
- Contadores em memória por `(sessionId, channel)`, gravados a cada 10 s e no fim da sessão com **upsert** (`seconds = valor atual acumulado`), portanto regravar é seguro.
- **Sugestões**: uma linha por `requestId` com restrição `UNIQUE`; conta apenas `suggestion.done`.
- Tabelas: `usage_audio(session_id, user_id, channel, seconds, updated_at)` PK `(session_id, channel)`; `usage_suggestion(request_id PK, session_id, user_id, created_at)`.
- Banco: SQLite no MVP, via camada de repositório que permita trocar por Postgres.

## 7. Erros e UI

| Falha | Servidor | UI |
|---|---|---|
| Queda da conexão STT | Reconecta até 3× com backoff; frames não entregues não são cobrados. | Faixa amarela "Transcrição instável"; após 3 falhas, vermelha "Transcrição parada" + botão Reiniciar. |
| Tradução | 1 nova tentativa; depois `translation.error`. | Frase só em inglês com ícone "tradução indisponível". |
| Sugestão | Timeout 15 s ou erro do provedor → `suggestion.error`. | Mensagem + botão "Tentar de novo" (novo `requestId`). |
| Microfone negado | Sessão só com canal `them`. | Aviso "Sugestões sem suas falas". |
| Token inválido | Fechamento `4401`/`4403`. | "Chave de acesso inválida" + campo para reinserir. |
| Sessão substituída | `session.superseded` / `session.ended replaced`. | "Sessão aberta em outro lugar". |
| Queda de rede | — | Indicador "Reconectando…"; marcadores `audio.gap` / snapshot com gap. |

## 8. Privacidade e segurança

- Chaves de Deepgram, DeepL e Anthropic somente no servidor.
- Áudio nunca é gravado em disco.
- Transcrições apenas em memória; apagadas no fim da sessão (após a carência de 60 s).
- Logs com métricas, códigos de erro e IDs; nunca o conteúdo da conversa.
- Validação de `Origin`, de tamanho de frame e de todas as mensagens JSON (schema em `shared`).
- Limites: tamanho máximo de `context` (2.000 caracteres); taxa máxima de `suggest.request` (1 a cada 2 s por sessão).

## 9. Testes

- **Unitários (Vitest)**, sem rede:
  - `utterance-assembler`: `is_final` vs `speech_final` vs `UtteranceEnd`; um único `utterance.end` quando ambos chegam.
  - `sentence-splitter`: pontuação, limite de 2,5 s (relógio falso), limite de 30 palavras, `sentenceIdx` estável.
  - Validação de frames: tamanhos válidos/inválidos, frame final curto, duração calculada.
  - Dedup de `frameSeq` por canal e detecção de gap.
  - Buffer de eventos e retomada: dentro do buffer, fora do buffer (snapshot com gap).
  - Registro de sugestões: pedido novo, repetido em andamento, repetido concluído.
  - Metering: upsert idempotente, unicidade por `requestId`.
- **Integração**: servidor real com `FakeStt`, `FakeTranslator`, `FakeSuggester` reproduzindo sequências gravadas do Deepgram; cliente WebSocket de teste cobrindo início, queda, retomada, socket substituído, sessão substituída, expiração.
- **Ponta a ponta opcional** (`E2E_PROVIDERS=1`): arquivo de áudio em inglês pelos provedores reais, validando as metas de latência.
- **Extensão**: testes unitários do `session-store` (aplicação ordenada por `seq`, snapshot); teste manual guiado no Meet (roteiro no plano).

## 10. Decisões registradas

| Decisão | Motivo |
|---|---|
| Todo áudio pelo backend (abordagem A) | Chaves protegidas, cobrança medida no servidor, troca de provedor sem atualizar a extensão. |
| Offscreen document como dono da sessão | O service worker do MV3 pode ser suspenso; o side panel pode fechar. |
| Descartar áudio durante queda | Reenviar atrasaria a legenda ao vivo; o usuário vê o marcador de trecho perdido. |
| Sugestão só sob demanda | Escolha do usuário; controla custo de LLM. |
| Saída `<en>…</en><pt>…</pt>` | Mais simples de processar em streaming que JSON. |
| DeepL para tradução | Latência baixa e boa qualidade em PT-BR; trocável por Claude via interface. |
