# Reforma visual do Staff Dashboard — V4

## Resultado

O painel administrativo foi redesenhado como uma aplicação operacional responsiva, com hierarquia visual mais clara, navegação adequada ao contexto de uso, experiência mobile em nível de PWA e paridade real entre os modos claro e escuro.

A V4 preserva as funções e a arquitetura operacional consolidadas na V3, mas substitui a camada de apresentação e acrescenta comportamentos específicos para uso diário em celular.

## Diagnóstico que orientou a reforma

Os principais problemas encontrados na interface anterior eram:

- excesso de estilos concorrentes e diferenças visuais entre módulos;
- cores usadas sem uma função semântica consistente;
- navegação mobile derivada do desktop, com prioridade inadequada para tarefas recorrentes;
- controles pequenos, toolbars comprimidas e excesso de informação simultânea;
- modais pouco naturais no celular;
- modo escuro com superfícies, bordas e textos de contraste irregular;
- cartões de jogadores com estados de verificação ambíguos;
- ações críticas disponíveis mesmo sem conexão;
- ausência de uma camada consistente de safe areas e altura dinâmica de viewport;
- sobreposição de ação flutuante no topo e cabeçalhos contaminados por regras globais antigas;
- gestos de fechar e atualizar acionados em áreas amplas demais.

## Sistema visual

### Paleta semântica

- **Azul:** navegação, seleção, foco e ação principal.
- **Verde:** integridade operacional, conexão, sucesso e saúde do servidor.
- **Dourado:** identidade Força Aliada, destaque institucional e estados de propriedade.
- **Âmbar:** atenção e pendência que exigem triagem.
- **Vermelho:** risco, falha e ação destrutiva.

Essa separação evita que o verde da identidade do Manager seja usado indiscriminadamente como cor de interface. O verde continua presente, mas comunica principalmente saúde e confirmação. O dourado preserva a personalidade do site principal, enquanto o azul organiza a interação administrativa.

### Modo claro

- fundo marfim suave, em vez de branco puro;
- cartões em porcelana, com contraste e elevação discretos;
- tipografia verde-grafite para reduzir aspereza visual;
- bordas mais leves e sombras curtas;
- estados azuis, verdes, dourados, âmbar e vermelhos com fundos tonais próprios.

### Modo escuro

- base grafite com subtom verde, coerente com o ecossistema Força Aliada;
- superfícies elevadas claramente separadas sem depender de sombras pesadas;
- textos principais quentes e textos secundários neutros;
- botões azuis escurecidos para manter contraste de leitura;
- badges e estados refeitos para não perder legibilidade.

## Arquitetura de navegação

### Desktop

A barra lateral foi reorganizada em três grupos reconhecíveis:

1. **Operação:** visão geral, servidor e acesso.
2. **Comunidade:** jogadores, economia, moderação e comunicação.
3. **Sistema:** auditoria, integrações e configurações.

O cabeçalho mantém busca global, tema, saúde do servidor, notificações e conta. A área principal ganhou largura, ritmo vertical e cabeçalhos consistentes entre os módulos.

### Mobile

A navegação inferior passa a priorizar as tarefas mais frequentes:

1. Visão geral;
2. Pendências;
3. Jogadores;
4. Servidor;
5. Mais.

“Mais” abre uma folha inferior agrupada por contexto, sem remover o usuário da tarefa atual. A barra respeita safe areas e mantém cinco alvos de 56 px mesmo em 320 px de largura.

O cabeçalho mobile funciona como app bar: marca compacta, nome do módulo atual, busca, notificações e perfil. A página usa `100dvh`, `viewport-fit=cover` e espaçamento para recortes e barras do sistema.

## Componentes e interações

- cartões, tabelas, listas, filtros, tabs, toolbars e formulários receberam uma linguagem única;
- áreas de toque mobile têm pelo menos 44 × 44 px;
- campos usam 16 px no celular, evitando zoom automático no iOS;
- formulários longos usam folhas inferiores ou tela cheia, conforme o espaço disponível;
- diálogos têm scrim, foco contido, fechamento previsível e tratamento para voltar no Android;
- a ação rápida flutuante é contextual e aparece apenas após o usuário rolar a tela;
- a atualização por gesto só começa no topo real do conteúdo e ignora áreas interativas;
- o gesto de fechar modal só nasce no cabeçalho, reduzindo acionamentos acidentais;
- estado offline é visível e ações de mutação críticas ficam indisponíveis até a conexão retornar;
- gráficos sincronizam as cores com o tema sem recriar ou clonar proxies internos da biblioteca.

## Melhorias por ferramenta

### Visão geral

- saúde do servidor, fila operacional, API e onboarding ganham prioridade;
- métricas secundárias foram separadas de decisões pendentes;
- fila de atenção mostra no máximo os sinais mais importantes e sua próxima ação;
- economia e capacidade operacional ficam acessíveis sem competir com alertas.

### Acesso

- o pipeline explica cada etapa entre conta, Minecraft, fila, Manager e servidor;
- estados “na fila” e “reservada” foram descritos sem sugerir confirmação inexistente;
- inclusão manual abre um formulário mobile em folha inferior;
- o diálogo final foi testado sem sobreposição de título e descrição.

### Jogadores

- filtros de segmento são roláveis e têm alvos de toque adequados;
- seleção múltipla recebeu checkbox customizado de 44 px;
- e-mails deixam de poluir os cartões pequenos;
- “verificado” foi dividido em conceitos explícitos: “E-mail pendente” e “Selo da plataforma”;
- ações agora usam “Selo ativo” e “Conceder selo”, reduzindo ambiguidade;
- cartões preservam cargo, rank, mérito, capital e atividade em ordem visual coerente.

### Servidor

- status, capacidade, uptime, heatmap, atividade e presença usam superfícies consistentes;
- filtros e comparações se adaptam sem criar rolagem horizontal da página;
- estado operacional usa verde somente quando representa saúde real.

### Economia

- mérito e capital foram tratados como dimensões relacionadas, mas não equivalentes;
- saldos, progressão e distribuição usam tipografia numérica e cores com função clara;
- ações financeiras não competem visualmente com métricas de leitura.

### Moderação e pendências

- contagem consolidada alimenta o atalho mobile de Pendências;
- denúncia, fila de IA e acesso são tratados como tipos distintos de decisão;
- seleção e ações em lote mantêm alvos seguros para toque;
- cores de risco foram reservadas para severidade, falha e destruição.

### Comunicação

- compositor, público, agendamento e prévia ficam no mesmo fluxo visual;
- todos os campos usam 16 px no celular;
- área de mensagem tem 120 px de altura mínima;
- botões de formatação foram ampliados para 44 px;
- a prévia permanece separada da ação de envio.

### Auditoria, integrações e configurações

- auditoria recebeu ação de exportação consistente com o restante do painel;
- integrações usam estados de saúde, escopo e credenciais visualmente distintos;
- configurações organizam preferências, segurança e comportamento sem misturar ações destrutivas;
- todos os três módulos foram revisados em largura mobile e nos dois temas.

## PWA

O manifesto agora usa o nome “Força Aliada Staff”, tema grafite, `display: standalone`, preferência por modo de janela completo quando suportado e cinco atalhos:

- Visão geral;
- Pendências;
- Jogadores;
- Servidor;
- Acesso.

O service worker foi atualizado para a versão de cache `fa-static-v31` e inclui os ativos da V4. A página offline de staff continua separada da experiência pública.

## Correções de bugs e regressões

- removida a exceção de recursão causada pela tentativa de espalhar proxies do Chart.js;
- corrigida a sobreposição de cabeçalho dentro de diálogos;
- corrigido o espaço duplicado abaixo da app bar mobile;
- corrigida a marca compacta no cabeçalho de celular;
- corrigidos rótulos invisíveis na folha “Mais”;
- corrigida a ação flutuante sobrepondo conteúdo no topo;
- eliminado overflow horizontal nos módulos testados em 320 px e 390 px;
- revisados tamanhos de campos, botões, chips, checkboxes e tabs;
- removidas ambiguidades de verificação nos cartões de jogadores;
- corrigidos gestos de swipe e pull-to-refresh excessivamente amplos;
- corrigida a cor do botão primário escuro para contraste mais seguro.

## Arquivos principais

- `dashboard.html`: integração, metadados PWA e ajustes semânticos.
- `assets/css/dashboard-v4.css`: tokens, temas, componentes e responsividade.
- `assets/js/dashboard-v4.js`: tema, navegação mobile, folha “Mais”, ação contextual, offline e sincronização visual.
- `assets/js/dashboard-v2.js`: correções de gesto e atualização por arrasto.
- `staff.webmanifest`: identidade e atalhos da aplicação.
- `service-worker.js`: cache versionado dos ativos da V4.
- `staff-offline.html`: fallback administrativo offline.

## Validação executada

- desktop em 1280 px e 1440 × 900;
- mobile em 390 × 844 e 320 × 568;
- modos claro e escuro;
- navegação principal, folha “Mais” e troca de módulos;
- diálogo de inclusão na fila de acesso;
- cartões, filtros e seleção de jogadores;
- compositor de comunicação;
- módulos de servidor, economia, moderação, auditoria, integrações e configurações;
- ausência de overflow horizontal nas larguras testadas;
- campos mobile em 16 px;
- alvos interativos visíveis com pelo menos 44 px;
- diálogo de acesso com input de 44 px e sem sobreposição de cabeçalho;
- console do navegador sem erros ou avisos na checagem final;
- manifesto JSON válido;
- nenhum `id` duplicado em `dashboard.html`;
- todos os arquivos locais listados no cache existem;
- contagem equilibrada de chaves nos arquivos CSS e JavaScript da V4.

## Observação de implantação

A entrega altera o código local e o pacote final. Nenhuma publicação ou atualização em produção foi executada automaticamente.
