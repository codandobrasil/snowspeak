# SnowSpeak

Legendas EN→PT-BR em tempo real e sugestões de resposta para chamadas no navegador. A extensão funciona sozinha, com as chaves do próprio usuário: a transcrição usa o Deepgram, as sugestões usam o OpenRouter e a tradução roda no próprio Chrome.

- Spec atual: `docs/superpowers/specs/2026-09-27-byok-so-extensao-design.md`
- Specs e planos anteriores: `docs/superpowers/` (a versão com servidor está no histórico do git até o commit `0706794`)

## Requisitos

- Node 20+
- pnpm 9 (`corepack prepare pnpm@9.15.9 --activate`)
- Google Chrome 116+ (a tradução precisa do Chrome 138+ para desktop)
- Uma chave do Deepgram (console.deepgram.com → API Keys; a conta nova vem com crédito)
- Opcional: uma chave do OpenRouter para as sugestões (openrouter.ai → Keys)
- Python 3 (só para gerar o zip da loja)

## Desenvolvimento

```bash
pnpm install
pnpm test
pnpm --filter @snowspeak/extension build
```

1. Abra `chrome://extensions`, ative o **Modo do desenvolvedor**, clique em **Carregar sem compactação** e escolha `apps/extension/dist`.
2. Na aba que você quer capturar, clique no ícone do SnowSpeak. O painel abre associado **a essa aba**.
3. Em **Configurações**, cole a chave do Deepgram (e, se quiser sugestões, a do OpenRouter) e clique em **Testar chaves**.
4. Clique em **Iniciar**.

Depois de mudar o código: `pnpm --filter @snowspeak/extension build` e clique em recarregar no card da extensão.

## Como usar

### Configurações

Ficam no topo do painel e são salvas só neste navegador (`chrome.storage.local`).

| Campo | Para que serve |
|---|---|
| Chave do Deepgram | Obrigatória. Transcreve o áudio da aba e do microfone. |
| Chave do OpenRouter | Opcional. Sem ela, a legenda e a tradução funcionam, mas não há sugestões de resposta. |
| Modelo das sugestões | Padrão `anthropic/claude-haiku-4.5`; aceita qualquer modelo do OpenRouter. |
| Testar chaves | Confere as duas chaves e diz qual foi recusada. |
| Modo | Trabalho, Vendas, Entrevista ou Relacionamento: muda o tom das sugestões e o nome da coluna (Entrevistador/Participantes). |
| Contexto, currículo e vaga | Usados só para gerar as sugestões; a IA não inventa fatos que não estejam no currículo. |

### Durante a sessão

1. Na aba da chamada (Meet, Zoom no navegador, vídeo), clique no ícone do SnowSpeak e em **Iniciar**. O painel captura **a aba em que o ícone foi clicado**.
2. A legenda aparece em duas colunas: o participante à esquerda (inglês e, logo abaixo, a tradução em verde) e você à direita. A fala atual do participante fica em destaque; as anteriores, esmaecidas.
3. Interjeições como "hmm", "uh-huh", "yeah", "claro" e "sim" não aparecem na legenda.
4. Se a conexão com o Deepgram cair, aparece "Reconectando ao Deepgram…" e a legenda volta sozinha (até 60 s).

Barra de botões:

| Botão | O que faz |
|---|---|
| Iniciar / Parar | Começa e termina a captura. O Parar espera as últimas palavras. |
| Só português | Mostra só a tradução das falas do participante. |
| Microfone | Liga ou desliga o envio da sua voz (nada da sua voz sai do computador enquanto desligado). |
| Resposta curta / média / longa | Tamanho da sugestão: 1 frase, 2 a 3 frases ou 4 a 6 frases com um exemplo do currículo. Vale na hora. |
| Sugestões ligadas / desligadas | Desligado, nenhum pedido vai ao OpenRouter. |
| Baixar PDF | Baixa a conversa inteira em PDF (veja abaixo). |
| Limpar | Apaga da tela as falas e a sugestão prontas; a conversa continua guardada para o PDF. |

### Sugestões de resposta

Nada é gerado sozinho. A sugestão sai quando você:
- clica numa fala terminada do participante (ou Tab + Enter nela): responde àquela pergunta;
- clica em **Sugerir resposta** ou aperta **Alt+S**: responde à última fala do participante.

A sugestão aparece logo abaixo da pergunta, em inglês, com a tradução em português.

### Abrir em janela

O botão **Abrir em janela**, no cabeçalho, abre o mesmo painel numa janela própria do Chrome, que pode ser arrastada para outro monitor e redimensionada. A janela captura a aba que o painel estava mostrando. Painel lateral e janela mostram a mesma sessão.

### Baixar PDF

O botão **Baixar PDF** abre um relatório diagramado e a janela de impressão do Chrome; escolha **Salvar como PDF**. O nome sugerido é `SnowSpeak – <modo> – <data> <hora>`. Se fechar a impressão, o botão **Salvar PDF** no topo da página abre de novo.

O relatório traz, em A4:
- cabeçalho com data, início, fim, duração e modo;
- contexto e descrição da vaga, quando preenchidos;
- a conversa inteira, na ordem, com o horário de cada fala, a tradução das falas do participante e a marca de "fala interrompida";
- cada sugestão num quadro logo abaixo da pergunta a que respondeu;
- numeração de páginas no rodapé.

A conversa inteira fica guardada até o próximo **Iniciar**, inclusive as falas que já saíram da tela (o painel mostra só as 200 mais recentes) e depois do **Limpar**. Nada sai do navegador para gerar o PDF.

### Privacidade

Não há servidor do SnowSpeak. O áudio vai direto do navegador ao Deepgram; a conversa, o modo, o contexto, o currículo e a vaga vão direto ao OpenRouter só quando você pede uma sugestão. A tradução roda no próprio Chrome. As chaves nunca aparecem em URLs nem em logs. Detalhes em `docs/loja/politica-de-privacidade.md`.

## Estrutura do projeto

| Pasta | Conteúdo |
|---|---|
| `packages/engine` | O motor que roda no offscreen: cliente do Deepgram (WebSocket do navegador, com reconexão), montagem de falas e frases, sugestões pelo OpenRouter e a sessão local (`LocalSession`). |
| `packages/shared` | Tipos das mensagens do motor, áudio e o detector de interjeições. |
| `apps/extension` | A extensão MV3: service worker, documento offscreen (captura, motor, tradução, registro da conversa), painel lateral e a página do relatório em PDF. |
| `apps/extension/icons-src` | Logo original e a versão recortada com cantos transparentes, de onde saem os ícones. |
| `docs/loja` | Política de privacidade e textos da listagem da Chrome Web Store. |
| `docs/superpowers` | Specs e planos de cada etapa. |

### Ícones

Os ícones em `apps/extension/public/icons/` saem de `apps/extension/icons-src/logo.png` (1024×1024, cantos transparentes). Para trocar o logo, gere de novo:

```bash
cd apps/extension
for s in 16 32 48; do magick icons-src/logo.png -resize ${s}x${s} -depth 8 public/icons/icon-$s.png; done
magick icons-src/logo.png -resize 96x96 -background none -gravity center -extent 128x128 -depth 8 public/icons/icon-128.png
```

O de 128 px tem a arte em 96 px com 16 px de margem, como pede a Chrome Web Store.

## BYOK — roteiro de validação

- [ ] Em `chrome://extensions` → Detalhes do SnowSpeak → Acesso ao site, aparecem só `api.deepgram.com` e `openrouter.ai`.
- [ ] Iniciar sem a chave do Deepgram: "Informe a chave do Deepgram em Configurações." e nada é capturado.
- [ ] **Testar chaves** com as duas chaves certas: "Deepgram: ok · OpenRouter: ok".
- [ ] **Testar chaves** com uma chave errada em cada campo: "chave recusada" no provedor certo.
- [ ] **Testar chaves** sem a chave do OpenRouter: "OpenRouter: não configurada (sem sugestões)".
- [ ] Iniciar com a chave do Deepgram errada: "Não foi possível conectar ao Deepgram. Confira a chave em Configurações." e a captura é liberada.
- [ ] Sessão com as duas chaves num vídeo de entrevista em inglês: legenda, tradução e sugestão automática como nos marcos 3 a 5.
- [ ] Sessão sem a chave do OpenRouter: legenda e tradução funcionam; o cartão mostra "Sugestões desligadas: informe a chave do OpenRouter." e o botão de sugerir fica desabilitado.
- [ ] Chave do OpenRouter errada numa sessão: o cartão mostra "O OpenRouter recusou a chave. Confira em Configurações."
- [ ] Desligar o Wi-Fi por ~10 s no meio da sessão: aparece "Reconectando ao Deepgram…", a fala em andamento fica como interrompida, e ao religar o aviso some e a legenda volta.
- [ ] Desligar o Wi-Fi por mais de 60 s: aparece "A transcrição dos participantes parou: não foi possível reconectar ao Deepgram." e a sessão continua até o Parar.
- [ ] Conexão travada sem cair: no DevTools do offscreen (`chrome://extensions` → Inspecionar visualizações → offscreen.html → Rede), escolher "Offline" por ~10 s no meio da sessão: em até ~5 s aparece "Reconectando ao Deepgram…" e, ao voltar para "Sem limitação", a legenda volta.
- [ ] Parar no meio de uma frase: "Finalizando…", as últimas palavras aparecem, depois "Parado".
- [ ] Fechar e reabrir o painel mantém a legenda e o aviso de reconexão.
- [ ] Nenhuma chave aparece no console do offscreen (`chrome://extensions` → Inspecionar visualizações → offscreen.html) nem em URLs na aba Rede.
- [ ] A legenda e a sugestão estão maiores e fáceis de ler.
- [ ] Interjeições do entrevistador ou suas ("hmm", "hummmm", "uh-huh", "yeah", "claro", "sim") não aparecem na legenda; uma frase que só começa com "yeah, so…" aparece.
- [ ] Uma pergunta do entrevistador **não** gera sugestão sozinha; clicar no bloco dele gera a resposta para aquela pergunta.
- [ ] O botão "Sugerir resposta" e o Alt+S respondem à última fala do entrevistador.
- [ ] Resposta curta, média e longa mudam o tamanho da sugestão, inclusive no meio da sessão.
- [ ] **Sugestões desligadas**: clicar nos blocos, o botão e o Alt+S não geram nada; ao religar, voltam. A escolha fica salva.
- [ ] **Abrir em janela**: o painel abre numa janela que dá para arrastar para outro monitor; Iniciar nessa janela captura a aba em que você clicou no ícone.
- [ ] **Baixar PDF** (durante ou depois da sessão, mesmo depois do Limpar): abre o relatório com data, horários, duração, modo, contexto, vaga, todas as falas com tradução e cada sugestão abaixo da pergunta; a impressão abre sozinha e "Salvar como PDF" sugere o nome `SnowSpeak – <modo> – <data> <hora>`.
- [ ] Repetir numa chamada real do Google Meet.

## Publicação na Chrome Web Store

```bash
pnpm --filter @snowspeak/extension package
```

Gera `apps/extension/snowspeak-<versão>.zip`. Para enviar:

1. Publique `docs/loja/politica-de-privacidade.md` num endereço público e guarde a URL.
2. Na conta de desenvolvedor da Chrome Web Store, crie o item e envie o zip.
3. Preencha a listagem, as permissões e as práticas de dados com `docs/loja/listagem.md`, e envie as capturas de tela listadas lá.
4. A cada versão nova, aumente `version` em `apps/extension/public/manifest.json` e `apps/extension/package.json` e gere o zip de novo.

- [ ] Carregar o conteúdo do zip descompactado (Carregar sem compactação) e repetir os itens principais do roteiro BYOK: ícone na barra, Testar chaves, uma sessão com legenda e sugestão.

## Roteiros anteriores (versão com servidor)

Os roteiros abaixo foram validados na versão com servidor e ficam como histórico.

### Marco 1 — roteiro de validação

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

### Marcos 3 e 4 — roteiro de validação (com a chave do Deepgram)

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

### Marco 5 — roteiro de validação (com a chave do OpenRouter)

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
- [x] **Microfone** desliga o envio da sua voz: o botão fica vermelho ("Microfone desligado"), a coluna Você para de receber falas e a legenda do entrevistador segue normal. Clicar de novo religa.
- [ ] Repetir numa chamada real do Google Meet.

### Marco 2 — roteiro de validação (reconexão)

Ponha `DEV_ENDPOINTS=1` no `apps/server/.env` e reinicie o servidor.

- [x] No meio da sessão, `curl -X POST localhost:8787/dev/drop-sockets`: o painel mostra "Reconectando…" por um instante e volta para "Capturando"; a legenda anterior continua e as falas seguem aparecendo.
- [x] A fala que estava em andamento na queda aparece como "fala interrompida"; a seguinte ganha um bloco novo, sem repetir texto.
- [x] Uma sugestão pedida logo antes da queda aparece depois da volta.
- [x] Parar o servidor e esperar mais de 60 s: aparece "A conexão ficou fora por muito tempo e a sessão foi encerrada.", a captura é liberada e a legenda continua visível.
- [x] Reiniciar o servidor no meio da sessão: aparece a mesma mensagem (as sessões vivem na memória do servidor).
- [x] Clicar em Parar durante "Reconectando…": Parado, sem captura.
- [x] Iniciar uma sessão em outro perfil do Chrome com a mesma chave: a primeira mostra "Sessão encerrada: foi iniciada em outro lugar."
- [x] Com o servidor em outra máquina, desligar o Wi-Fi por ~10 s e religar: a sessão volta sozinha.
