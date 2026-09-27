# Chrome Web Store — listagem do SnowSpeak

## Nome
SnowSpeak

## Resumo (até 132 caracteres)
Legendas em português e sugestões de resposta em chamadas em inglês, com as suas chaves do Deepgram e do OpenRouter.

## Categoria
Produtividade (Ferramentas)

## Idioma
Português (Brasil)

## Descrição
O SnowSpeak ajuda quem participa de reuniões e entrevistas em inglês.

- Legenda ao vivo: o que os participantes dizem aparece em inglês e, logo abaixo de cada frase, em português.
- Suas falas aparecem ao lado, para você acompanhar a conversa inteira.
- Sugestões de resposta: quando alguém faz uma pergunta, o SnowSpeak sugere uma resposta curta em inglês, com a tradução, usando o seu currículo e a descrição da vaga (modo Entrevista) ou o contexto que você informar. Você também pode clicar numa pergunta ou apertar Alt+S para pedir a sugestão.
- Funciona em qualquer aba do Chrome: Google Meet, Zoom e Teams no navegador, vídeos.

Como funciona: o SnowSpeak usa as suas próprias chaves de API. A transcrição é feita pelo Deepgram (chave obrigatória; a conta nova vem com crédito) e as sugestões pelo OpenRouter (chave opcional). A tradução roda no próprio Chrome. Não há servidor do SnowSpeak no meio: o áudio e o texto vão direto do seu navegador para esses serviços, e as chaves ficam só no seu Chrome.

Requisitos: Chrome 138 ou mais novo no computador para a tradução.

## Finalidade única
Transcrever e traduzir o áudio de uma aba em chamada e sugerir respostas, num painel lateral.

## Justificativa das permissões
- tabCapture: capturar o áudio da aba da chamada, só depois que o usuário clica no ícone e em Iniciar.
- offscreen: documento que processa o áudio e mantém a conexão com o Deepgram durante a sessão, mesmo com o painel fechado.
- sidePanel: mostrar a legenda e as sugestões ao lado da página.
- activeTab: o clique no ícone autoriza a captura daquela aba.
- storage: guardar no próprio navegador as chaves, o currículo, a vaga e as preferências.
- Host api.deepgram.com: transcrição e teste da chave do Deepgram.
- Host openrouter.ai: sugestões de resposta e teste da chave do OpenRouter.
- Código remoto: não usa.

## Práticas de dados (formulário da loja)
Sugestão de respostas, a conferir pelo usuário no formulário:
- Dados tratados: comunicações pessoais (áudio e transcrição das chamadas) e informações pessoais que o usuário escolher colar (currículo, descrição da vaga).
- Esses dados vão só aos serviços que o usuário configurou (Deepgram e OpenRouter), com as chaves dele, para a função principal da extensão.
- Certificações: não vende dados a terceiros; não usa nem transfere dados para fins não relacionados à finalidade única; não usa dados para avaliar crédito ou conceder empréstimos.
- URL da política de privacidade: publicar `docs/loja/politica-de-privacidade.md` num endereço público (ex.: GitHub Pages ou Gist público) e colar a URL aqui.

## Capturas de tela (1280×800)
1. Painel durante uma entrevista em inglês: coluna do entrevistador com as frases traduzidas e a sugestão de resposta abaixo da pergunta.
2. Configurações preenchidas, depois de "Testar chaves" mostrar "Deepgram: ok · OpenRouter: ok" (com as chaves mascaradas).
3. Modo "Só português" durante uma reunião.
