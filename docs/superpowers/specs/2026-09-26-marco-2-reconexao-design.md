# SnowSpeak — Marco 2: reconexão e retomada da sessão

Complementa a spec `2026-09-25-snowspeak-realtime-engine-design.md` (§5). Onde as duas divergem, vale esta.

## 1. Objetivo

Uma queda de rede não pode encerrar a chamada. Hoje, qualquer fechamento do WebSocket encerra a sessão no servidor e a captura no cliente.

Um **reinício do servidor** continua encerrando as sessões (elas vivem na memória, spec original §6.4): a retomada recebe `4404` e o usuário clica em Iniciar de novo. Isso vale também para o `--watch` do desenvolvimento.

Critério de sucesso: com uma queda de até 60 s, a sessão continua sozinha, sem clique do usuário. A legenda, as traduções e a sugestão ficam na tela durante a queda, e na volta chegam os eventos que o cliente perdeu. O áudio do intervalo aparece como lacuna (`audio.gap`), com a duração exata.

## 2. Escopo

Entra:

- sessão que sobrevive 60 s sem socket e buffer de eventos para repor o que o cliente perdeu;
- `session.resume` e a reconexão automática com backoff no cliente;
- uma retomada assume a sessão (`4409` para o socket antigo); um `session.start` com a mesma chave encerra a sessão anterior (`4410`, `replaced`).

Fica de fora (e por quê):

- **Medição de uso e SQLite** (§6 da spec original): serve para cobrança, que ainda não existe. Volta com o subprojeto de conta.
- **Snapshot de estado** (`session.snapshot`): o store do offscreen sobrevive à queda, e o buffer sem parciais (§3.2) cobre 60 s com folga. Se o buffer não cobrir, a sessão é tratada como expirada.
- **Botão "Usar aqui"** para `4409`: só o próprio offscreen conhece o `resumeToken`, então o `4409` na prática atinge um socket que o cliente já abandonou.
- **Limite de 4 h por sessão** e **reconexão automática do Deepgram** quando só ele cai.

## 3. Servidor

### 3.1 Registro de sessões

O gateway passa a manter um registro em memória:

- `sessionId → Session`;
- `chave de acesso → sessionId ativo` (uma sessão ativa por chave).

A `Session` deixa de receber o `send` do socket no construtor. Ela tem no máximo um socket ligado:

- `attach(send)`: liga um socket; eventos novos passam a ir para ele;
- `detach()`: desliga o socket atual (sem encerrar a sessão).

### 3.2 Buffer de eventos

- Todo evento com `seq` é emitido para o socket ligado (se houver) e guardado num buffer circular de **2.000** eventos.
- **`transcript.partial` não entra no buffer.** Ele é provisório e é a maior parte dos eventos; o texto firme chega depois como `transcript.segment`. Parciais emitidos sem socket ligado se perdem.
- `firstBuffered` = menor `seq` no buffer; `throughSeq` = último `seq` emitido.
- O `seq` continua avançando para parciais, então há saltos de `seq` no replay. O cliente já aceita saltos (aplica qualquer `seq > lastSeq`).

### 3.3 Queda do socket (fechamento sem `session.stop`)

1. `detach()`.
2. Fechamento forçado das falas nos dois canais, com as regras atuais (`Finalize`, até 500 ms, depois `utterance.end { interrupted: true }`), e fechamento das conexões STT.
3. A sugestão em andamento **continua**; seus eventos vão para o buffer.
4. Começa o prazo de retomada: **60 s**. Se ninguém retomar, a sessão é encerrada (`close()`: cancela a sugestão, fecha tudo) e sai do registro.

Frames que chegarem de um socket já desligado são descartados.

### 3.4 `session.resume`

Mensagem (primeira do socket, mesmo prazo de 5 s do `session.start`):

```ts
{ type: "session.resume"; token: string; sessionId: string; resumeToken: string; lastSeq: number }
```

Validação, nesta ordem:

| Condição | Resultado |
|---|---|
| `token` inválido | fecha com `4401` |
| sessão inexistente ou expirada, `resumeToken` diferente, ou sessão criada com outra chave | fecha com `4404` |
| `lastSeq` > `throughSeq` | fecha com `4400` |
| `lastSeq` < `firstBuffered − 1` (eventos perdidos já saíram do buffer) | encerra a sessão e fecha com `4404` |

Se passar:

1. Se outro socket estiver ligado, ele recebe `session.superseded` e é fechado com `4409`.
2. Cancela o prazo de retomada e faz `attach()` do novo socket.
3. Envia `session.resumed { throughSeq }` e em seguida os eventos do buffer com `seq` entre `lastSeq + 1` e `throughSeq`, em ordem. Eventos novos vêm depois.
4. Reabre as conexões STT dos dois canais. O `ChannelSequencer` mantém `frameSeq` e `sampleOffset` esperados; o primeiro frame depois da volta gera `audio.gap { reason: "client_drop" }` com a duração da queda.

O `resumeToken` é fixo durante a sessão (como na spec original).

### 3.5 Uma sessão por chave

Um `session.start` com uma chave que já tem sessão ativa encerra a anterior: `close()`, `session.ended { reason: "replaced" }` e fechamento com `4410` do socket dela (se houver). Depois cria a nova sessão normalmente.

### 3.6 `session.stop` e encerramento

Sem mudança de comportamento: drena as falas, `close()`, `session.ended { reason: "stopped" }`, `4410`. A sessão sai do registro.

### 3.7 Sinal de vida

- A cada **5 s**, o servidor envia ao socket ligado `heartbeat { v, type, sessionId }` (controle, sem `seq`). O cliente usa isso para perceber que a conexão morreu (§5.1).
- A cada **10 s**, o servidor manda um ping do WebSocket; o socket que não responder ao ping anterior é derrubado (`terminate`), o que conta como queda (§3.3).

### 3.8 Endpoint de desenvolvimento

Com `DEV_ENDPOINTS=1` no `.env`, `POST /dev/drop-sockets` derruba todos os sockets (`terminate`, o cliente vê `1006`) sem encerrar as sessões. Sem a variável, o endpoint responde 404. Serve para validar a retomada no Chrome.

### 3.9 Configuração

`resumeWindowMs` (60.000), `eventBufferSize` (2.000), `heartbeatIntervalMs` (5.000) e `pingIntervalMs` (10.000) entram no `ServerConfig`, com esses padrões, para os testes usarem valores curtos; não viram variáveis de ambiente. `devEndpoints` vem de `DEV_ENDPOINTS`.

## 4. Protocolo (`packages/shared`)

- Cliente → servidor: nova mensagem `session.resume` (§3.4). `lastSeq` é inteiro ≥ 0; `sessionId` e `resumeToken` não vazios.
- Servidor → cliente:
  - `session.resumed { v, type, sessionId, throughSeq }` (controle, sem `seq`). Sem o campo `strategy` da spec original.
  - `session.superseded { v, type, sessionId }` (controle).
  - `heartbeat { v, type, sessionId }` (controle). O store ignora.
  - `session.snapshot` **não existe**.

## 5. Extensão

### 5.1 Reconexão no `SessionController`

O controlador considera a conexão morta se ficar **15 s** sem receber nenhuma mensagem do servidor (o `heartbeat` chega a cada 5 s). Nesse caso fecha o socket e segue como numa queda.

Quando o socket fecha com um código que não é de aplicação (qualquer código fora de `4400–4499`, ex.: `1006`, `1001`), durante uma sessão já iniciada e sem Parar pedido:

1. A captura **continua**. O `FrameSender` já descarta frames com o socket fechado e mantém os contadores avançando.
2. O store vai para o status `reconnecting`; o painel mostra "Reconectando…".
3. Novas tentativas com espera de **0,5 → 1 → 2 → 4 → 8 → 10 s** (depois, 10 s), até **60 s** contados da queda.
4. Cada tentativa abre um socket e envia `session.resume` com a chave, `sessionId`, `resumeToken` e o `lastSeq` do store.
5. `session.resumed` → status `running`. Os eventos repostos passam pelo store (que ignora `seq ≤ lastSeq`) e pela fila de tradução, que só recebe frases novas.
6. Tentativa que falha sem código de aplicação → próxima espera. Com código de aplicação → §5.2.
7. Passados 60 s sem sucesso → encerra como `4404`.

Pedidos de sugestão (`Alt+S`, botão, clique na pergunta) e mudanças de configuração feitos durante a reconexão são ignorados, como hoje sem sessão.

Parar durante a reconexão cancela as tentativas, libera a captura e vai para Parado.

### 5.2 Reação a cada fechamento

| Situação | Reação |
|---|---|
| Sem código de aplicação | Reconecta (§5.1). |
| `4401` | Para. "Chave de acesso inválida." |
| `4404`, `4400` ou 60 s sem sucesso | Para a captura. "A conexão ficou fora por muito tempo e a sessão foi encerrada." A legenda fica visível até o próximo Iniciar. |
| `4409` | Para. "Sessão aberta em outro lugar." |
| `4410` depois de `session.ended { reason: "replaced" }` | Para. "Sessão encerrada: foi iniciada em outro lugar." |
| `4410` depois de Parar | Parado (como hoje). |

"Para" = libera a captura e o socket; status de erro com a mensagem, como os erros atuais.

### 5.3 Estado

- `SessionStatus` ganha `reconnecting`. O modo captura do painel continua ativo nesse status.
- O store guarda o `resumeToken` recebido em `session.started` (o `sessionId` e o `lastSeq` já existem).
- `session.resumed` não zera nada no store (ao contrário de `session.started`).

## 6. Testes

Servidor (integração pelo WebSocket, prazos curtos na config):

- queda e retomada: os eventos perdidos chegam depois de `session.resumed`, em ordem, sem parciais;
- `heartbeat` periódico; socket que não responde ao ping é derrubado e a sessão fica aguardando retomada;
- `/dev/drop-sockets` derruba os sockets só com `DEV_ENDPOINTS=1`;
- `audio.gap` com a duração da queda no primeiro frame depois da volta;
- sugestão concluída durante a queda chega na reposição;
- `4401`, `4404` (sessão expirada, `resumeToken` errado, outra chave, buffer estourado) e `4400`;
- socket antigo recebe `session.superseded` e `4409` quando outro retoma;
- `session.start` com a mesma chave: a sessão anterior recebe `session.ended { reason: "replaced" }` e `4410`;
- a sessão expirada sai do registro e fecha o STT e a sugestão.

Unitários: buffer de eventos (limite, exclusão de parciais, faixa de replay).

Extensão (controlador com sockets e relógio falsos):

- sequência de esperas e limite de 60 s;
- 15 s sem mensagens do servidor derruba o socket e inicia a reconexão;
- `session.resume` com `sessionId`, `resumeToken` e `lastSeq` corretos;
- a captura segue durante a reconexão e volta a enviar frames depois de `session.resumed`;
- Parar durante a reconexão;
- reação a cada código da tabela §5.2.

Store: `reconnecting`, `resumeToken` e `session.resumed` sem zerar o estado.

## 7. Roteiro de validação no Chrome

Com `DEV_ENDPOINTS=1` no `.env`:

- No meio da sessão, `curl -X POST localhost:8787/dev/drop-sockets`: "Reconectando…" por um instante, depois "Capturando"; a legenda anterior continua, as falas seguem aparecendo e a primeira fala depois da volta não repete nada.
- Com o servidor noutra máquina (ou o `wss://` de produção), desligar o Wi-Fi por ~10 s e religar: a sessão volta sozinha.
- Parar o servidor e esperar mais de 60 s: a mensagem de sessão encerrada aparece, a captura é liberada e a legenda fica visível.
- Reiniciar o servidor no meio da sessão: a retomada recebe `4404` e aparece a mesma mensagem (comportamento esperado, §1).
- Parar durante "Reconectando…": Parado, sem captura.
- Iniciar uma sessão em outro perfil do Chrome com a mesma chave: a primeira mostra "Sessão encerrada: foi iniciada em outro lugar."
