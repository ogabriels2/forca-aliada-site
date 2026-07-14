# Auditoria e remodelação do painel de staff — V3

Data da revisão: julho de 2026  
Escopo: `dashboard.html`, experiência administrativa, ferramentas individuais, contratos de API relacionados e integração com o Força Aliada Manager.

## Resultado executivo

O painel deixou de funcionar como uma coleção extensa de cartões e atalhos concorrentes e passou a operar como um produto administrativo com três responsabilidades claras:

1. **Visão geral para decidir:** estado atual, filas e no máximo três sinais que pedem ação.
2. **Módulos para executar:** cada domínio tem um local principal e uma linguagem consistente.
3. **Auditoria para comprovar:** decisões sensíveis deixam motivo, autor, alvo e contexto.

A intervenção não foi apenas visual. Ela corrigiu regras contraditórias de economia, proteção do último dono, reenvio de whitelist, ambiguidade de moderação, concorrência na fila do Manager, limite de comunicação por data de entrega e vários pontos de segurança, acessibilidade e resiliência.

## O que foi analisado

- Estrutura completa, hierarquia, navegação, estados, responsividade e tema do painel existente.
- Fluxos de jogadores, acesso, whitelist, Mérito, Capital, moderação, comunicação, auditoria, integrações, migrações Legacy e configurações.
- Rotas administrativas e regras de persistência em `backend/src/server.mjs`, `admin_dashboard_v2.mjs`, `admin_analytics.mjs` e `server_legacy_migration.mjs`.
- Contrato de coleta da whitelist pelo Manager, heartbeat, chaves de integração e estados realmente observáveis.
- Comportamento em desktop e viewport compacto, incluindo navegação inferior.
- Estados de carregamento, vazio, erro, confirmação, offline, permissão e dados incompletos.
- Exposição de PII, exportações, fórmulas em CSV, interpolação de conteúdo, URLs externas e ações destrutivas.

## Diagnóstico do painel anterior

### Arquitetura de informação

- Havia navegação primária, abas superiores, atalhos de contexto, ações rápidas e ferramentas genéricas disputando a mesma função.
- “Centro de comando”, “Community Intelligence”, estatísticas, ferramentas e cartões antigos repetiam métricas sem deixar clara a próxima decisão.
- Acesso e whitelist eram parte importante da operação, mas não existiam como módulo operacional de primeira classe.
- Integrações misturavam divulgação do aplicativo com administração de credenciais.
- Ferramentas especializadas apareciam como destino principal, mesmo sendo contexto de Jogadores, Economia, Servidor ou Auditoria.

### Clareza operacional

- Um escore genérico de saúde escondia sinais reais; a staff precisava inferir o problema.
- Vários rótulos estavam em inglês ou em linguagem interna: “Broadcast”, “Top earners”, “Merit Velocity”, “Role” e “players”.
- Números repetiam descrições genéricas, como “economia consolidada” ou “visão da quinzena”, sem explicar o que o indicador permitia concluir.
- O histórico vinha antes da fila em Moderação, empurrando a tarefa urgente para baixo da dobra.
- A tela do Manager dizia “entregue” sem distinguir recebimento pelo endpoint de aplicação efetiva no Minecraft.

### Integridade e segurança

- Débitos de Mérito e Capital podiam produzir diferença entre saldo e razão transacional em condições de concorrência ou saldo insuficiente.
- Limites de rank existiam em mais de um contrato e podiam divergir.
- Era possível tentar remover ou rebaixar o último dono sem uma invariável transacional explícita.
- Redefinir senha não revogava todas as sessões da conta afetada.
- Exclusão de notas não restringia de forma suficiente o autor da nota.
- Migrações Legacy aceitavam um papel administrativo mais amplo que o necessário.
- A moderação podia tentar remover tipos legados cujo conteúdo original não era identificável com precisão.
- Reenvio de whitelist apagava o estado de entrega sem preservar uma trilha própria de tentativas.
- Coleta da whitelist podia sofrer disputa entre duas instâncias do Manager.
- O limite diário de avisos contava o dia de criação, não a data efetiva de entrega, e não era protegido contra concorrência.
- URLs de avisos não tinham uma validação explícita de protocolo no ponto de criação.
- A base da API podia ser alterada por armazenamento local em produção.
- Exportações CSV aceitavam células iniciadas por caracteres interpretados como fórmula.
- Dependências CDN não possuíam verificação de integridade.

### Acessibilidade e resiliência

- Alguns botões de ícone não tinham nome acessível.
- Módulos inativos eram escondidos visualmente, mas não eram isolados com `inert` e `aria-hidden`.
- Tooltips construídos com conteúdo CSS poluíam a árvore de acessibilidade.
- Badges com valor zero continuavam aparecendo por conflito entre `display` e o atributo `hidden`.
- Não havia uma experiência offline específica para a área administrativa.
- Falhas de inicialização podiam substituir toda a página por uma mensagem pouco segura e sem navegação de recuperação.

## Nova arquitetura

| Grupo | Módulo | Pergunta que responde | Ação principal |
|---|---|---|---|
| Operação | Visão geral | O que exige atenção agora? | Resolver um dos três sinais prioritários |
| Operação | Servidor | O servidor está disponível e sendo usado? | Investigar presença, uptime e sessões |
| Operação | Acesso | Quem ainda não concluiu o onboarding? | Corrigir vínculo, criar ou reenviar entrada |
| Comunidade | Jogadores | Quem é a pessoa e qual é seu estado? | Localizar, segmentar e abrir o perfil operacional |
| Comunidade | Economia | Os saldos e a progressão estão saudáveis? | Revisar e registrar uma transação |
| Comunidade | Moderação | O que precisa de decisão humana? | Manter ou remover com contexto e motivo |
| Comunidade | Comunicação | Quem precisa receber qual aviso e quando? | Enviar ou agendar um aviso |
| Sistema | Auditoria | Quem fez o quê, quando e por quê? | Investigar e exportar evidência |
| Sistema | Integrações | Quais instalações do Manager possuem acesso? | Criar ou revogar uma credencial identificável |
| Sistema | Configurações | Quais regras globais estão ativas? | Revisar e salvar parâmetros do projeto |

Insights, migrações Legacy e análises especializadas continuam disponíveis de forma contextual, sem poluir a navegação primária.

## Decisões de design

### Hierarquia visual

- Sidebar escura e estável para orientação; superfície principal neutra para leitura prolongada.
- Verde identifica operação saudável ou ação construtiva; âmbar indica atenção; vermelho fica reservado a erro, risco e decisão destrutiva; azul representa informação e navegação.
- Uma página possui um único título principal, uma descrição curta e ações locais no canto previsível.
- Cartões de KPI exibem valor, definição contextual e tom sem depender somente de cor.
- Bordas, raios, espaçamento, tipografia, estados de foco e densidade foram unificados em `dashboard-v3.css`.
- A experiência compacta usa navegação inferior e menu “Mais”, preservando a mesma arquitetura do desktop.

### Visão geral

- Remove o escore opaco e mostra quatro sinais explícitos: servidor, fila operacional, API/dados e onboarding/acesso.
- Limita a cinco KPIs operacionais para reduzir ruído.
- A “Fila de atenção” mostra no máximo três itens, sempre com próximo passo.
- Economia permanece como leitura rápida; a execução acontece no módulo próprio.
- Comparação de períodos aparece apenas onde faz sentido analítico.

## Melhorias por ferramenta

### Acesso e whitelist

- Novo módulo de primeira classe com quatro estágios: aguarda e-mail, aguarda Minecraft, na fila e reservada pelo endpoint.
- Busca, filtro por estado, histórico de envio, integração consumidora e contagem de reenvios.
- Inclusão manual valida formato do nick e, quando uma conta é indicada, confere existência, vínculo e correspondência de identidade.
- Entradas ainda na fila não oferecem uma falsa ação “Priorizar”; exibem “Aguardando coleta”.
- Reenvio exige justificativa, preserva a tentativa anterior e cria evento de auditoria.
- A coleta do Manager usa seleção atômica com `FOR UPDATE SKIP LOCKED`.
- A interface declara honestamente que “reservada” significa coleta pelo endpoint. A confirmação de aplicação no Minecraft ainda não é instrumentada.
- E-mail é retornado apenas ao papel `owner` nos endpoints novos.

### Jogadores

- O segmento padrão passa a ser “Todos os jogadores”; “Equipe” vira um recorte, não a visão dominante.
- Segmentos foram reescritos em linguagem operacional: sem cadastro, sem atividade há 30 dias e entradas dos últimos sete dias.
- Filtros de permissão foram traduzidos e os alternadores lista/cartões receberam nomes acessíveis.
- Insights e risco de afastamento são acessos contextuais, não módulos redundantes na navegação.
- Exportações selecionadas neutralizam fórmulas de planilha.
- Modal mantém jornada, dados de conta, sessões, Mérito, Capital e notas no contexto da pessoa.

### Economia

- Indicadores passaram a explicar o contrato: Mérito emitido, Capital em circulação, concentração de Gini e transações por dia.
- Rótulos e descrições foram inteiramente localizados para português.
- O formulário segue “selecionar → preencher → revisar → registrar”.
- Débitos agora bloqueiam saldo insuficiente com `409`, dentro da mesma transação que grava o razão e atualiza o saldo.
- Linhas de Mérito e Capital não podem mais divergir do saldo por uso de `Math.max` fora do contrato transacional.
- Progressão usa uma regra única e imutável: Ferro 0, Ouro 150, Diamante 500 e Netherite 1000.
- Configurações deixaram de editar os limites silenciosamente; qualquer mudança futura exige migração versionada e testes de contrato.

### Moderação

- Resumo e fila aparecem antes do gráfico histórico.
- Confiança mínima da triagem assistida inicia em 80% e nunca abaixo de 70% na interface.
- Itens que deixam de passar pelo filtro são removidos da seleção em lote.
- Remoção exige decisão humana e motivo com tamanho mínimo.
- Somente itens pendentes aceitam decisão; repetição retorna conflito.
- Alvos legados ambíguos não são removidos automaticamente e informam por que a ação está indisponível.
- URLs de mídia são validadas, abertas com `noopener/noreferrer` e não são inseridas em manipuladores inline.
- O único lote preservado é “Manter conteúdos selecionados”; remoção em lote ambígua foi retirada.

### Comunicação

- “Broadcast & Avisos” virou “Central de comunicação”.
- Editor, público, agendamento, link, modelos e prévia ocupam uma única área coerente.
- A prévia é chamada de “Prévia na central”, sem prometer equivalência perfeita com todos os canais.
- O botão muda entre “Enviar aviso” e “Agendar aviso” conforme a data.
- Datas locais são convertidas para ISO UTC com referência explícita a `America/Sao_Paulo`.
- Links aceitam somente HTTP/HTTPS ou caminho público válido.
- O limite é calculado pela data de entrega em São Paulo, não pela data em que o agendamento foi criado.
- Uma trava transacional impede ultrapassar o limite com requisições simultâneas.
- Cliques em links possuem rota de registro; a cobertura completa em todas as superfícies consumidoras continua no backlog.

### Auditoria

- Busca por ator/mensagem tem debounce de 350 ms.
- Severidade, período, categoria, lista/timeline, heatmap e atores mais ativos foram agrupados.
- Ações sensíveis novas incluem motivo e metadados relevantes.
- CSV central neutraliza fórmulas.
- Módulos inativos usam `inert` e `aria-hidden`, evitando que leitores de tela percorram conteúdo invisível.

### Integrações

- A promoção do Manager foi removida do painel operacional.
- O módulo concentra credenciais, estado conhecido e último uso.
- Toda chave nova recebe um nome escolhido pelo dono para identificar computador ou instalação.
- A chave completa aparece uma única vez e usa Clipboard API com fallback.
- Revogação exige justificativa e confirmação de senha, retorna `404` quando a chave não existe e registra motivo na Auditoria.
- O botão de revogação não interpola mais o nome da chave dentro de JavaScript inline.

### Configurações

- Área exclusiva do dono, com estado de alterações não salvas e alerta ao sair.
- Remoção automática deixou de ser uma opção aceita; os modos são revisão manual ou triagem assistida por IA.
- Canais e limite de avisos foram reescritos conforme a regra real de entrega.
- Exportações ganharam nomes legíveis e aviso de tratamento restrito.
- Ações destrutivas sistêmicas foram retiradas do navegador e os endpoints retornam bloqueio. Elas só devem voltar com backup durável, previsão de impacto, reautenticação dedicada e recuperação testada.

## Proteções transversais implementadas

- Proteção transacional contra rebaixar ou excluir o último dono.
- Bloqueio de autoexclusão e autorrebaixamento.
- Redefinição de senha revoga todas as sessões da conta afetada.
- Exclusão de nota limitada ao dono ou ao autor da nota.
- Migrações Legacy limitadas a `owner`.
- Timeout padrão de 15 segundos para chamadas da API.
- Base da API fixa em produção; armazenamento local não redireciona o painel para origem arbitrária.
- Toasts com `textContent`, tipos permitidos e região viva.
- Proteção contra fórmula em todas as exportações CSV revisadas.
- SRI SHA-384 e `crossorigin` para Chart.js e Lucide.
- Fallback administrativo offline específico, sem exibir dados antigos como se fossem atuais.
- Service worker versionado com os recursos V2/V3 e rota `staff-offline.html`.
- Dependências visuais carregadas sem bloquear o HTML principal.

## Verificações realizadas

- Renderização local da Visão geral, Acesso, Jogadores, Economia, Moderação, Comunicação, Auditoria, Integrações e Configurações.
- Inspeção da árvore semântica em viewport amplo e compacto.
- Scripts `dashboard-v2.js`, `dashboard-v3.js`, `service-worker.js` e os dois scripts inline: sintaxe válida.
- Módulo lazy e quatro módulos backend principais: sintaxe ESM válida.
- Um único `h1` e nenhum ID duplicado em `dashboard.html`.
- Dois recursos CDN com SRI.
- Nenhum caractere de substituição UTF-8 no HTML.
- Respostas HTTP 200 para dashboard, CSS/JS V2/V3, fallback offline e service worker no servidor local.
- Badges zerados efetivamente ocultos.
- Módulos inativos isolados da navegação assistiva.

## Arquivos centrais da remodelação

- `dashboard.html`
- `assets/css/dashboard-v2.css`
- `assets/css/dashboard-v3.css`
- `assets/js/dashboard-v2.js`
- `assets/js/dashboard-v2-lazy.js`
- `assets/js/dashboard-v3.js`
- `staff-offline.html`
- `service-worker.js`
- `backend/src/server.mjs`
- `backend/src/admin_dashboard_v2.mjs`
- `backend/src/admin_analytics.mjs`
- `backend/src/server_legacy_migration.mjs`

## Limitações conhecidas e próxima etapa recomendada

As limitações abaixo foram mantidas explícitas para não transformar ausência de telemetria em falsa certeza.

### Alta prioridade

1. **ACK de whitelist no Minecraft:** adicionar um retorno assinado do Manager com `queue_id`, comando executado, horário, resultado e erro. Só então usar o estado “Aplicada”.
2. **Reautenticação dedicada:** criar `/api/auth/reauth` com validade curta, sem gerar uma nova sessão de login, para chaves, credenciais e mudanças críticas.
3. **Sessão em cookie HttpOnly:** migrar gradualmente o token do armazenamento local, com proteção CSRF e CSP compatível.
4. **Entrega multicanal:** registrar tentativas e resultado por canal de push/e-mail/dashboard, não apenas a existência do aviso.

### Evolução estrutural

5. Extrair o HTML e JavaScript legado ainda grande em módulos por domínio. A V3 unifica a experiência e os contratos, mas a base continua estratificada para preservar compatibilidade.
6. Eliminar os manipuladores inline restantes e ativar CSP estrita/Trusted Types.
7. Servir Chart.js e Lucide localmente; SRI reduz risco, mas self-hosting elimina dependência operacional do CDN.
8. Transformar exportações completas em jobs paginados/streaming com expiração e registro de download.

### Qualidade analítica

9. Versionar definições de alcance, dwell, retenção e coortes; alguns indicadores continuam direcionais porque a granularidade histórica é acumulada ou parcial.
10. Exibir cobertura de amostra para uptime, coortes e períodos incompletos.
11. Instrumentar o consumo de links de aviso em todas as páginas e apps.

## Ordem segura de publicação

1. Fazer backup do banco e testar migrações em ambiente de homologação.
2. Publicar o backend com as novas tabelas e invariáveis.
3. Validar login, papéis, último dono, Mérito/Capital, whitelist e notificações concorrentes.
4. Publicar frontend e service worker na mesma janela.
5. Invalidar cache antigo e confirmar carregamento de `dashboard-v3.css` e `dashboard-v3.js`.
6. Testar com uma conta `owner` e uma conta `full`, em desktop e mobile.
7. Acompanhar logs, auditoria, erros `409/423/429` e heartbeat do Manager nas primeiras horas.

Esta entrega está preparada localmente. Publicação, alteração de infraestrutura e envio ao repositório remoto não foram executados automaticamente.
