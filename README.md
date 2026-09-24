# Jambra

Mural colaborativo no estilo Jamboard: caneta, marca-texto, post-its, texto, formas, imagens e vários quadros por mural. Várias pessoas editam ao vivo pelo mesmo link, e os murais podem ser salvos no Google Drive.

É um site estático (HTML + JavaScript, sem build), feito para rodar no **GitHub Pages**.

- **Colaboração ao vivo:** Firebase Realtime Database (plano gratuito)
- **Salvar/abrir:** Google Drive de cada pessoa (pasta "Jambra")
- **Desenho:** [Konva](https://konvajs.org)

Sem configuração, o app roda em **modo local**: funciona, mas sem colaboração, e os murais ficam só no navegador.

---

## 1. Testar no computador

Abrir o `index.html` com duplo clique **não funciona**, porque o navegador bloqueia os módulos JavaScript em `file://`. Rode um servidor local na pasta do projeto:

```bash
python3 -m http.server 8123
```

e abra <http://localhost:8123>.

## 2. Publicar no GitHub Pages

1. Crie um repositório no GitHub (ex.: `jambra`) e envie estes arquivos.
2. No repositório: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `(root)`** → Save.
3. Em ~1 minuto o site fica em `https://SEU-USUARIO.github.io/jambra/`.

## 3. Ativar a colaboração ao vivo (Firebase)

1. Acesse <https://console.firebase.google.com> → **Adicionar projeto** (o Google Analytics pode ficar desligado).
2. **Criação → Realtime Database → Criar banco de dados** → escolha a região → **Iniciar no modo bloqueado**.
3. Na aba **Regras**, cole o conteúdo de [`database.rules.json`](database.rules.json) e clique em **Publicar**.
4. **Criação → Authentication → Vamos começar → Método de login → Anônimo → Ativar.**
   (Cada visitante recebe um login anônimo invisível; ninguém precisa criar conta.)
5. **Authentication → Configurações → Domínios autorizados → Adicionar domínio:** `SEU-USUARIO.github.io`
6. **⚙️ Configurações do projeto → Seus apps → Web (`</>`)** → registre o app → copie o `firebaseConfig`.
7. Cole os valores em [`js/config.js`](js/config.js), no bloco `firebase` (confira se o `databaseURL` veio junto; se não vier, ele aparece no topo da página do Realtime Database).

> O `apiKey` do Firebase não é segredo. Ele identifica o projeto, e quem protege os dados são as regras do passo 3.

## 4. Ativar o Google Drive

Use o **mesmo projeto**: o Firebase cria um projeto no Google Cloud com o mesmo nome.

1. Acesse <https://console.cloud.google.com> e selecione o projeto no topo.
2. **APIs e serviços → Biblioteca →** procure **Google Drive API** → **Ativar**.
3. **APIs e serviços → Tela de permissão OAuth** (ou "Google Auth Platform"):
   - Tipo de usuário: **Externo**. Nome do app: `Jambra`. Preencha seu e-mail.
   - Em **Acesso a dados / Escopos**, adicione `.../auth/drive.file`.
   - Em **Público**, clique em **Publicar app** (status "Em produção") para que qualquer pessoa consiga fazer login.
     O escopo `drive.file` não é "sensível", então **não exige a verificação demorada do Google**.
4. **APIs e serviços → Credenciais → Criar credenciais → ID do cliente OAuth**
   - Tipo: **Aplicativo da Web**
   - **Origens JavaScript autorizadas:** `https://SEU-USUARIO.github.io` e `http://localhost:8123`
5. Copie o **ID do cliente** (termina em `.apps.googleusercontent.com`) para `googleClientId` em [`js/config.js`](js/config.js).

Com o escopo `drive.file`, o app só enxerga os arquivos que ele mesmo criou, nunca o resto do Drive da pessoa.

---

## Como funciona

- Cada quadro é um slide com o tamanho do Google Slides widescreen 16:9: **960×540 px**. A exportação em PNG e as imagens de fundo saem em 1920×1080. Murais criados antes dessa mudança continuam em 1600×900.
- **Imagem de fundo** (botão ao lado do contador de quadros) aceita imagem ou **PDF**. Um PDF com várias páginas, como uma apresentação baixada do Google Slides em Arquivo → Fazer download → PDF, pode virar um quadro por página, com o fundo nítido.
- Cada mural tem um código no link (`.../#b=abc123`). **Quem tem o link edita.**
- As alterações são enviadas ao Firebase na hora e aparecem para todos, com os cursores de cada pessoa.
- **Salvar no Drive** cria um arquivo `.jambra.json` na pasta "Jambra" do Drive de quem clicou. Depois disso, o mural é salvo sozinho a cada ~15 s enquanto houver alterações.
- **Abrir do Drive** lista os murais salvos. Se o mural ainda existir no Firebase, entra na sessão ao vivo; se não, recria a partir do arquivo.
- Também dá para **baixar/importar** o mural como `.json` e **exportar o quadro como PNG**.

## Atalhos

| Tecla | Ação |
|---|---|
| V / H / P / M / E | Selecionar / mover tela / caneta / marca-texto / borracha |
| N / T / S / I | Post-it / texto / formas / imagem |
| Espaço (segurar) ou botão do meio | Mover a tela |
| Ctrl + roda do mouse, pinça no trackpad | Zoom |
| Ctrl+Z / Ctrl+Shift+Z | Desfazer / refazer |
| Ctrl+C / Ctrl+V / Ctrl+D | Copiar / colar / duplicar |
| Delete | Excluir seleção |
| Enter ou duplo clique | Editar texto do post-it |
| Shift (desenhando forma) | Quadrado/círculo perfeito, linha em 45° |
| PgUp / PgDn | Quadro anterior / próximo |

No celular ou tablet: um dedo desenha e dois dedos movem e dão zoom.

## Limites do plano gratuito do Firebase

100 conexões simultâneas, 1 GB armazenado e 10 GB/mês de download. Para turmas e grupos é bastante. As imagens coladas são reduzidas automaticamente para ocupar menos espaço.

## Estrutura

```
index.html            página
css/style.css         visual
js/config.js          suas chaves (Firebase e Google)
js/main.js            quadro, ferramentas e interface
js/sync.js            sincronização (Firebase ou modo local)
js/drive.js           Google Drive
database.rules.json   regras do Realtime Database
```
