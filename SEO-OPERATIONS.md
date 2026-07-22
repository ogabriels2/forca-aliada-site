# Operacao de SEO da Forca Aliada

Este arquivo registra as etapas que dependem de paineis externos ou credenciais e, por isso, nao podem ser concluidas apenas com codigo.

## Publicacao e dominio

1. Publicar o frontend como Cloudflare Pages incluindo `_worker.js`, `_routes.json` e `_headers`.
2. No Render, definir:
   - `FRONTEND_BASE_URL=https://accounts.ogabriels.com`
   - `PUBLIC_BASE_URL=https://forcaaliada.com`
   - `PUBLIC_SHARE_BASE_URL=https://forcaaliada.com`
3. Confirmar que `https://forcaaliada.com/sitemap.xml` retorna XML, e nao `index.html`.
4. Confirmar que `/share/post/:id` e `/share/profile/:identifier` respondem pelo dominio principal.

## Cloudflare

O recurso "Managed robots.txt" do Cloudflare pode substituir o `robots.txt` deste repositorio. Ele esta atualmente bloqueando crawlers de IA, em conflito com a permissao declarada em `llms.txt`. Desative o override ou alinhe os Content Signals no painel antes de considerar a visibilidade para IA concluida.

Ative Brotli, HTTP/3 e cache de borda. Para as rotas `/share/*` e `/sitemap*.xml`, respeite os cabecalhos `s-maxage` enviados pelo backend.

## Google e Bing

1. Criar/verificar uma propriedade de dominio no Google Search Console.
2. Enviar `https://forcaaliada.com/sitemap.xml`.
3. Inspecionar a home, `/guia`, uma share page de perfil e uma share page de post.
4. Repetir o envio no Bing Webmaster Tools.
5. Monitorar cobertura, Core Web Vitals, consultas de marca e paginas descobertas.

## Google Analytics 4

O carregador de GA4 e opcional e esta implementado em `assets/js/fa-seo.js`. Para ativa-lo, adicione a paginas publicas:

```html
<meta name="google-analytics-id" content="G-SEU-ID-REAL">
```

Nao use um ID ficticio. Defina consentimento e retencao de dados de acordo com a politica de privacidade.

## Render e disponibilidade

Cold start nao e resolvido de forma confiavel por codigo da aplicacao. Use um plano sem suspensao ou monitor externo permitido pelo provedor. O cache publico das share pages reduz o impacto, mas nao substitui disponibilidade do backend.

## Perfis sociais

Atualize as bios e links oficiais nas redes sociais para apontar ao dominio canonico. Inclua apenas URLs de perfis realmente controlados no `sameAs` do schema `Organization`.
