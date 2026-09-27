# Política de privacidade do SnowSpeak

Última atualização: 27 de setembro de 2026

## Português

O SnowSpeak é uma extensão do Chrome que mostra legendas em português e sugestões de resposta durante chamadas em inglês. Ela funciona com as chaves de API do próprio usuário e não tem servidor próprio: o desenvolvedor não recebe, não armazena e não vê nenhum dado.

**O que fica no seu navegador.** As chaves do Deepgram e do OpenRouter, o modelo escolhido, o modo, o contexto, o currículo, a descrição da vaga e as preferências do painel ficam em `chrome.storage.local`, só neste navegador. Eles não são sincronizados com a sua conta Google. A legenda da sessão fica na memória da extensão e some quando o Chrome fecha a extensão.

**O que sai do seu navegador, e para onde.** Só depois de você clicar em Iniciar numa aba:
- o áudio da aba e, se você permitir, do microfone vai direto ao **Deepgram** (api.deepgram.com), com a sua chave, para ser transcrito;
- se você informou a chave do OpenRouter, a transcrição recente, o modo, o contexto, o currículo e a descrição da vaga vão direto ao **OpenRouter** (openrouter.ai), com a sua chave, para gerar a sugestão de resposta. O OpenRouter repassa o pedido ao provedor do modelo escolhido.

A tradução roda no próprio Chrome (Translator API) e não envia nada. O botão Testar chaves faz uma consulta ao Deepgram e ao OpenRouter só para verificar se a chave é aceita.

O uso desses dados pelo Deepgram e pelo OpenRouter segue as políticas deles: https://deepgram.com/privacy e https://openrouter.ai/privacy.

**O que o SnowSpeak não faz.** Não vende dados, não usa dados para publicidade, não coleta estatísticas de uso e não envia nada a outros destinos além dos dois citados.

**Como apagar.** Apague as chaves e os textos nas Configurações do painel ou remova a extensão; o Chrome apaga o `chrome.storage.local` junto com ela.

**Contato:** mpneves1974@gmail.com

## English

SnowSpeak is a Chrome extension that shows Portuguese captions and reply suggestions during calls in English. It runs on the user's own API keys and has no server of its own: the developer does not receive, store or see any data.

**What stays in your browser.** Your Deepgram and OpenRouter keys, chosen model, mode, context, résumé, job description and panel preferences are kept in `chrome.storage.local`, in this browser only, and are not synced to your Google account. Session captions live in the extension's memory and are discarded when Chrome closes the extension.

**What leaves your browser, and where it goes.** Only after you click Start on a tab:
- the tab audio and, if you allow it, your microphone audio go directly to **Deepgram** (api.deepgram.com), with your key, for transcription;
- if you entered an OpenRouter key, the recent transcript, mode, context, résumé and job description go directly to **OpenRouter** (openrouter.ai), with your key, to generate the reply suggestion. OpenRouter forwards the request to the provider of the chosen model.

Translation runs inside Chrome (Translator API) and sends nothing. The Test keys button calls Deepgram and OpenRouter only to check whether each key is accepted.

Deepgram's and OpenRouter's handling of this data follows their policies: https://deepgram.com/privacy and https://openrouter.ai/privacy.

**What SnowSpeak does not do.** It does not sell data, use it for advertising, collect usage analytics, or send anything anywhere other than the two services above.

**How to delete.** Clear the keys and texts in the panel's Settings or remove the extension; Chrome deletes its `chrome.storage.local` with it.

**Contact:** mpneves1974@gmail.com
