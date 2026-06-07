# Karaoke Family Hub

App de karaoke em AngularJS para uso em familia, com biblioteca local, perfis por apelido, ranking por score e destaque de letras sincronizado no estilo de captions dinamicas.

## O que ele entrega
- Biblioteca de musicas com busca e selecao
- Letras com foco visual por linha e por palavra
- Perfis com apelidos, emoji e pontuacao acumulada
- Ranking dos melhores scores
- Modo solo e dueto
- Sincronizacao de voz com penalidade "Fora de Ritmo", bonus por acerto e leitura leve de tom
- Importacao de repertorio local via pasta

## Como rodar
1. Entre na pasta `deliverables/karaoke-family-hub`
2. Instale as dependencias com `npm install`
3. Rode `npm run dev`
4. Abra a URL exibida pelo Vite

## Deploy no Vercel
O app é estático e pode ser publicado no Vercel sem backend.

Configuracao usada:
- build command: `npm run build`
- output directory: `dist`

Passos:
1. Crie um projeto novo no Vercel apontando para a pasta `deliverables/karaoke-family-hub`
2. Deixe o Vercel usar o `vercel.json` desta pasta
3. Faça o deploy

Observacao:
- O app usa microfone e reconhecimento de voz no navegador, entao para funcionar corretamente precisa estar em HTTPS e em navegador compatível.

## Estrutura esperada do repertorio
O importador aceita uma pasta com:
- `manifest.json` ou `repertory.json`
- Arquivos `.lrc` para as letras
- Arquivos de audio opcionais (`.mp3`, `.wav`, etc.)

Exemplo de `manifest.json`:

```json
{
  "title": "Repertorio da familia",
  "songs": [
    {
      "id": "casa-de-cantoria",
      "title": "Casa de Cantoria",
      "artist": "Família Solar",
      "genre": "Pop caseiro",
      "mode": "solo",
      "coverUrl": "https://example.com/covers/casa-de-cantoria.jpg",
      "coverLabel": "CC",
      "coverColor": "#1db954",
      "pitchGuideHz": 220,
      "pitchGuideLabel": "A3",
      "audioPath": "audio/casa-de-cantoria.mp3",
      "lyricsPath": "lyrics/casa-de-cantoria.lrc"
    }
  ]
}
```

## Observacao sobre score
O score e calculado localmente para a experiencia familiar. Ele combina progresso da musica, offset de sintonia, bonus por modo dueto e penalidades leves por timing/tom quando a leitura do microfone esta ativa.

### Opcional: referencia de tom
O manifest pode incluir `pitchGuideHz` por musica para habilitar a validacao leve de pitch no navegador. O app deriva automaticamente `pitchGuideLabel` quando ele nao for informado. O motor de score também usa a frequencia detectada no microfone para calcular nota e desvio em cents, e aplica penalidades diferentes quando o cantor fica acima ou abaixo do alvo. Se a faixa nao tiver essa referencia, o app continua funcionando apenas com timing e foco de letra.

### Capa da faixa
Cada faixa pode trazer `coverUrl` para uma imagem remota ou `coverPath` no import local. Se nenhuma capa for informada, o app gera uma capa visual deterministica com cor e sigla da musica.

## Voz e microfone
O recurso de sincronizacao de voz usa `SpeechRecognition` do navegador quando disponivel e tenta ler o tom via `getUserMedia` + `AudioContext` para feedback leve de pitch.
Para melhores resultados, teste no Chrome ou Edge em `http://localhost`.

## Repertorio de demo
O app carrega um repertorio demo local em `public/repertory/demo` para validar a experiencia sem precisar de arquivos externos.
