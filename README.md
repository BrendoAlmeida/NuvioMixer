# NuvioMixer

Servidor pessoal para combinar uma fonte de vídeo e outra de áudio e disponibilizar o resultado no Nuvio. O Mixer preserva os fluxos originais: vídeo e áudio são remuxados com `-c:v copy -c:a copy`, sem recodificação, para manter codecs, resolução, HDR, bitrate e canais.

> Projeto pessoal, pensado primeiro para uso próprio com Nuvio. Não há SLA, suporte garantido nem compromisso de manutenção.

## O que ele faz

- Conecta à conta Nuvio e sincroniza os manifests de addons configurados no perfil.
- Pesquisa filmes e séries, com seleção de temporada e episódio.
- Consulta fontes progressivamente, com filtros por provedor e lista virtualizada para muitos resultados.
- Permite escolher uma fonte para vídeo e outra para áudio.
- Oferece prévia de sincronização com ajuste de offset do áudio.
- Salva modelos de série: o addon procura a combinação equivalente de provedores/qualidade em cada episódio compatível.
- Publica as combinações por um endpoint de addon Stremio, consumido pelo Nuvio.
- Suporta fontes HTTP/HLS/DASH, fontes debrid e torrents via Torbox ou gateway externo legado.

## Compatibilidade

O alvo suportado é exclusivamente o **Nuvio**. O projeto expõe o protocolo de addon Stremio e, por isso, pode funcionar em alguns clientes Stremio; porém isso é apenas uma possibilidade técnica, não uma promessa de compatibilidade. Não há suporte oficial nem planos de adicionar suporte específico ao Stremio neste momento.

O dispositivo que reproduz o stream ainda precisa suportar os codecs da fonte. Como o NuvioMixer não recodifica, uma fonte HEVC, AV1, 10-bit, HDR ou de alta resolução continuará exigindo suporte nativo no player/dispositivo.

## Requisitos

- Docker Engine e Docker Compose v2.
- Uma chave `MASTER_KEY` de 32 bytes em Base64.
- Uma conta Nuvio, para a sincronização de addons.
- Opcional: uma chave de API do Torbox ou um gateway de torrent compatível, caso queira usar fontes torrent.

## Início rápido

```bash
git clone https://github.com/BrendoAlmeida/NuvioMixer.git
cd NuvioMixer
cp .env.example .env

# Gere e cole o valor em MASTER_KEY no arquivo .env
openssl rand -base64 32

docker compose up -d --build
```

Abra [http://localhost:7337](http://localhost:7337). Na primeira visita, conecte a conta Nuvio. O Mixer cifrará a sessão no volume local, sincronizará os manifests do perfil e, nas visitas seguintes, abrirá diretamente a busca.

Para acompanhar o serviço:

```bash
docker compose ps
docker compose logs -f nuvio-mixer
```

## Configuração

Copie `.env.example` para `.env`. O `.env` e os dados de execução já estão ignorados pelo Git.

| Variável | Uso |
| --- | --- |
| `MASTER_KEY` | Obrigatória. Chave Base64 de 32 bytes usada para cifrar sessão Nuvio e segredos locais. |
| `BASE_URL` | URL pública do Mixer. Use a URL HTTPS do Tailscale Funnel, Cloudflare Tunnel ou proxy reverso quando o Nuvio estiver em outra máquina. |
| `PUID` / `PGID` | Usuário e grupo donos da pasta `data/` no host; normalmente `1000`. |
| `SESSION_IDLE_MS` | Tempo, em milissegundos, que uma sessão de reprodução e seus fragmentos permanecem no disco após o último acesso. O padrão é `1800000` (30 minutos). |
| `STREAM_START_TIMEOUT_MS` | Tempo máximo, em milissegundos, para produzir a mídia inicial reproduzível. O padrão é `120000`. |
| `SEEK_SEGMENT_SECONDS` | Duração alvo dos segmentos do HLS VOD buscável. Os cortes finais seguem keyframes reais; o padrão é `4`. |
| `KEYFRAME_INDEX_TIMEOUT_MS` | Tempo máximo para a indexação inicial de keyframes no HLS VOD. O padrão é `1200000` (20 minutos). O índice é armazenado localmente sem URL ou credenciais. |
| `TORBOX_RESOLVE_URLS` | Opt-in para encaminhar URLs diretas públicas elegíveis ao Torbox WebDL. O padrão é `false`. |
| `TORRENT_GATEWAY_URL` | Gateway externo para resolver torrents. Deve responder a `GET /resolve?infoHash=<hash>&fileIdx=<índice>`. |
| `ALLOW_INSECURE_HTTP` | Permite fontes HTTP. Avalie o risco antes de ativar em ambientes expostos. |
| `ALLOW_PRIVATE_NETWORK` | Permite fontes em redes privadas/LAN. Avalie o risco antes de ativar. |

Quando exposto remotamente, configure `BASE_URL` para a URL HTTPS externa antes de instalar o manifest no Nuvio. Não exponha a porta 7337 diretamente à internet sem uma camada de autenticação e controle de rede.

### Torbox

Em **Configurações**, salve a chave de API do Torbox. Ela é cifrada com `MASTER_KEY` no volume Docker e a API do Mixer expõe apenas se o Torbox está configurado — nunca a chave.

O Torbox trata fontes torrent nativas no próprio serviço. A resolução de URLs diretas é desabilitada por padrão: ao definir `TORBOX_RESOLVE_URLS=true`, você autoriza o Mixer a encaminhar ao Torbox apenas URLs HTTP(S) públicas de arquivos, sem cabeçalhos de proxy, cookies, `Referer`, `Origin`, `User-Agent` ou outra autenticação fora da URL. Endereços privados/LAN e playlists HLS/DASH não são encaminhados. Fontes diretas que já venham de um debrid/Torbox seguem diretamente para o pipeline; elas não são reenviadas ao Torbox.

## Fluxo de uso

1. Entre com a conta Nuvio.
2. Pesquise um filme ou série.
3. Em séries, selecione um episódio de referência.
4. Escolha a fonte de vídeo e a fonte de áudio.
5. Use **Sincronizar fontes** para ajustar o offset, se necessário.
6. Valide e salve a combinação.
7. Opcionalmente, abra **Combinações** e use **Preparar localmente** para deixar o início, um trecho ou todo o VOD pronto antes de abrir no Nuvio.
8. Em **Configurações**, copie a URL do manifest do NuvioMixer e instale-a no Nuvio.

Para séries, o modelo salvo guarda o addon, tipo de fonte e qualidade escolhidos — não URLs temporárias do episódio. Quando o Nuvio solicitar outro episódio, o Mixer consulta somente os dois provedores escolhidos e disponibiliza a combinação apenas se ambos retornarem fontes equivalentes e validáveis.

## Reprodução e desempenho

Para cada combinação, o addon disponibiliza três alternativas. **HLS VOD buscável** entrega duração fixa e permite avançar sem recodificar: na primeira utilização da fonte, o Mixer indexa seus keyframes e guarda localmente somente a timeline derivada, sem URL, token ou credenciais. Esse passo pode ler a mídia uma vez e demorar em arquivos grandes; chamadas seguintes para a mesma fonte reutilizam o índice. **MP4 progressivo** é experimental: declara a duração conhecida do menor fluxo no cabeçalho MP4 e envia fragmentos à medida que são produzidos. Em fontes E-AC-3, o cabeçalho é emitido após o primeiro fragmento para que o codec seja identificado. Ela começa sem aguardar o arquivo inteiro, mas não permite busca para trechos ainda não gerados; quando o remux termina, os ranges e a busca voltam a ser normais. **HLS** é o fallback compatível: começa assim que há segmentos completos, mas a duração aumenta até a playlist terminar.

A reprodução pode levar alguns segundos para iniciar, conforme tamanho, codec e velocidade das fontes; o limite padrão para a mídia inicial é de 120 segundos. O resultado termina no menor dos dois fluxos selecionados, sem recodificação.

### Preload local e cache

Na página **Combinações**, o painel **Preparar localmente** prepara segmentos do HLS VOD no volume Docker antes da reprodução. Você pode preparar o início, um intervalo por tempo exato, tudo a partir de um ponto ou o título completo. O cache mantém a duração fixa e o seek do VOD: o Nuvio serve imediatamente os fragmentos já preparados e, para posições ainda ausentes, o Mixer continua preparando sob demanda.

Os segmentos permanecem no disco até limpeza manual. A página mostra progresso, tamanho em disco, avisos e logs sanitizados do pipeline; URLs de origem, tokens, cookies, headers e chaves não são exibidos. O painel permite limpar somente a mídia de uma combinação, mídia e índice de keyframes, ou todo o cache local.

O preload não reabre a fonte por segmento: cada intervalo solicitado é remuxado por um único processo contínuo, lendo vídeo e áudio uma vez e escrevendo o HLS/fMP4 diretamente no cache local. Em **Tudo**, a reprodução VOD passa a ser inteiramente local. Em **Trecho** ou **Do ponto ao fim**, apenas os fragmentos produzidos ficam locais; posições fora do intervalo continuam usando a stream normal sob demanda. Respostas temporárias `429` e interrupções de leitura são retomadas com backoff, preservando o trecho já pronto.

Fontes HLS/DASH com faixas separadas permitem buscar somente o áudio necessário. Em arquivos MKV/MP4 e torrents, o demux pode precisar ler dados de vídeo mesmo quando apenas o áudio é selecionado.

Torrents não são reproduzidos diretamente pelo NuvioMixer: configure o Torbox em **Configurações** ou defina `TORRENT_GATEWAY_URL` para um serviço de sua confiança. O projeto não inclui nem opera o gateway legado.

## Desenvolvimento

```bash
npm install
npm run dev       # UI Vite em http://localhost:5173; API encaminhada para 7337
npm test
npm run check
```

Para testar a imagem final localmente:

```bash
npm run build
npm start
```

## Limitações conhecidas

- O Mixer não recodifica para tornar codecs incompatíveis reproduzíveis.
- Uma origem que não permita leitura, seek ou remux HLS pode falhar.
- Diferença de duração entre áudio e vídeo não bloqueia a combinação, mas pode exigir ajuste de offset.
- Addons JavaScript arbitrários do Nuvio não são executados no servidor; o projeto usa o protocolo de addons Stremio/Nuvio.
- Compatibilidade com Stremio não é suportada nem testada como produto.

## Aviso legal e de responsabilidade

Este repositório disponibiliza software de uso pessoal para organizar e remuxar fontes indicadas pelo próprio usuário. O NuvioMixer não hospeda, indexa, fornece, distribui ou licencia obras audiovisuais, faixas de áudio, arquivos de mídia ou serviços de terceiros.

Ao utilizar o software, o usuário declara ser o único responsável por verificar e manter as autorizações, licenças, assinaturas, titularidade ou demais bases legais necessárias para acessar, reproduzir, combinar, armazenar ou transmitir qualquer conteúdo e cada fonte configurada. É vedado usar o projeto para violar direitos autorais, direitos conexos, contratos de serviço, medidas técnicas de proteção ou qualquer legislação aplicável.

O software é fornecido **“no estado em que se encontra”** e **“conforme disponível”**, sem garantias expressas ou implícitas de funcionamento ininterrupto, segurança, adequação a finalidade específica, compatibilidade com fontes de terceiros ou ausência de erros. Na máxima extensão permitida pela legislação aplicável, o autor não assume responsabilidade por perdas, danos, indisponibilidade, perda de dados, falhas de provedores, violações decorrentes de fontes configuradas pelo usuário ou uso indevido do software.
