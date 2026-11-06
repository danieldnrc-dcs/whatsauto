# WhatsApp Central Base

Base white-label para integrar o WhatsApp (pareamento por QR Code, como o WhatsApp Web) ao seu próprio sistema.
Você ganha um **worker** que mantém o número conectado, uma **API REST** para enviar e ler mensagens, **webhooks**
para ser avisado do que acontece e um **painel de demonstração** para parear o número e conversar.

Não tem nenhum dado, cliente ou regra de negócio embutida: o que é seu (cliente, ticket, setor…) entra pelos campos
livres `external_ref` e `metadata` de cada conversa.

> **Leia antes de usar.** Esta base usa a biblioteca não oficial [Baileys](https://github.com/WhiskeySockets/Baileys),
> que fala com o WhatsApp como se fosse um aparelho vinculado. **Não é a API oficial (WhatsApp Business Platform)**
> e o WhatsApp pode bloquear números que violem os termos de uso (spam, envio em massa, mensagens para quem não
> pediu). Use para atendimento a quem já fala com você, mantenha o ritmo de envio baixo e tenha um plano B.
> Para grande escala ou uso comercial crítico, prefira a API oficial.

## O que vem pronto

| Peça | O que faz |
|---|---|
| `src/worker.ts` | Um processo por número. Conecta por QR Code, guarda as credenciais **cifradas** no banco, recebe mensagens (texto, imagem, áudio, vídeo, documento, localização, contato, enquete), baixa arquivos, envia a fila com intervalo entre mensagens, confirma o número no WhatsApp antes do primeiro envio, atualiza entregue/lida, aplica **editar** e **apagar para todos**, avisa quando o contato apaga ou edita. |
| `src/api.ts` | API REST com chave de API, limite de requisições e painel de demonstração em `/`. |
| `src/webhooks.ts` | Entrega de eventos assinada (HMAC-SHA256), com novas tentativas e bloqueio de endereços internos (SSRF). |
| `sql/001_init.sql` | Banco (Postgres): números, conversas, mensagens, arquivos, chaves de API, webhooks. |
| `public/index.html` | Painel simples: escolher o número, ver o QR Code, listar conversas, responder. |

## Início rápido (Docker)

```bash
SECRET=$(openssl rand -base64 32) docker compose up --build
# em outro terminal, crie uma chave de API:
docker compose run --rm api node scripts/create-key.ts "meu backend"
```

Abra <http://localhost:3000>, cole a chave em **API key**, clique em **Connect / QR code** e leia o QR no celular:
WhatsApp → Aparelhos conectados → Conectar um aparelho.

Guarde o `SECRET`: ele cifra as credenciais do WhatsApp. Se for perdido, é preciso parear de novo.

## Início rápido (sem Docker)

Requer Node 24+ e um Postgres.

```bash
cp .env.example .env          # preencha DATABASE_URL e SECRET
npm install
set -a; . ./.env; set +a
npm run migrate
npm run create-key -- "meu backend"
npm run api                   # terminal 1
SESSION_ID=1 npm run worker   # terminal 2
```

Mais números: crie com `POST /v1/sessions` e rode **um worker por número** (`SESSION_ID=2 npm run worker`).

## API

Todas as rotas `/v1/*` pedem `Authorization: Bearer <chave>`.

| Método e rota | Para quê |
|---|---|
| `GET /v1/sessions` | Números cadastrados, estado (`disconnected`, `connecting`, `qr`, `connected`, `reconnecting`) e se o worker está no ar. |
| `POST /v1/sessions` `{ "name" }` | Cria um novo número (depois suba um worker para ele). |
| `POST /v1/sessions/:id/connect` | Pede a conexão e gera o QR Code. |
| `GET /v1/sessions/:id/qr` | `{ state, qr, qr_png }`: `qr_png` é uma imagem pronta (data URL). Renova sozinho. |
| `POST /v1/sessions/:id/disconnect` | Desvincula o aparelho e apaga as credenciais. |
| `POST /v1/messages` | Envia. Veja abaixo. |
| `POST /v1/messages/:id/edit` `{ "text" }` | Edita uma mensagem de texto enviada (até 15 min). |
| `POST /v1/messages/:id/delete` | Apaga para todos (até 2 dias). |
| `GET /v1/conversations?session=&external_ref=&limit=&before=` | Lista (mais recentes primeiro). |
| `GET /v1/conversations/:id` · `PATCH` | Lê/atualiza `external_ref`, `metadata`, `name`. |
| `GET /v1/conversations/:id/messages?limit=&before=` | Histórico, com `can_edit`/`can_delete`. |
| `POST /v1/media?name=arquivo.pdf` | Envia o arquivo cru (corpo = bytes, `Content-Type` = tipo). Devolve `id`. |
| `GET /v1/media/:id` | Baixa um arquivo recebido ou enviado. |
| `GET/POST/DELETE /v1/webhooks` | Gerencia webhooks. |

### Enviar uma mensagem

```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Authorization: Bearer $CHAVE" -H "Content-Type: application/json" \
  -d '{ "session": 1, "to": "5511999990000", "text": "Olá! Seu pedido saiu para entrega.",
        "idempotency_key": "pedido-1234-aviso-1" }'
```

- `to`: número com código do país e DDD, só dígitos (`+`, espaços e traços são aceitos e removidos).
- `idempotency_key`: **use sempre**. Repetir a mesma chave nunca envia duas vezes (devolve `duplicate: true`).
- Com arquivo: envie antes em `/v1/media` e passe `"media_id"`. Para responder uma conversa existente, use `"conversation"` no lugar de `to`.
- A resposta é `202`: a mensagem entrou na fila. O worker envia, e o resultado chega por webhook (`message.sent`, `message.status`, `message.failed`) ou consultando as mensagens.

Estados da mensagem: `queued` → `sending` → `sent` → `delivered` → `read`. Se a rede cair no meio do envio, fica `uncertain`
(pode ter saído ou não): **nunca é reenviada sozinha**, confira no celular.

## Webhooks

```bash
curl -X POST http://localhost:3000/v1/webhooks -H "Authorization: Bearer $CHAVE" -H "Content-Type: application/json" \
  -d '{ "url": "https://seu-sistema.com/hooks/whatsapp", "events": ["message.received", "message.status"] }'
```

A resposta traz o `secret` **uma única vez**. Eventos: `message.received`, `message.sent`, `message.status`,
`message.failed`, `message.edited`, `message.deleted`, `session.state`. Sem `events`, recebe todos.

Cada entrega é um `POST` JSON `{ event, at, data }` com os cabeçalhos `X-Webhook-Event`, `X-Webhook-Id`,
`X-Webhook-Timestamp` e `X-Webhook-Signature: sha256=<hex>`, onde a assinatura é
`HMAC-SHA256(secret, timestamp + "." + corpo)`. **Confira a assinatura** e rejeite timestamps antigos.
Responda `2xx` rápido; falhas são repetidas por até 8 vezes com espera crescente. A URL precisa ser `https` e não pode apontar
para endereço interno (para desenvolvimento local, `ALLOW_PRIVATE_WEBHOOKS=true`).

Exemplo de verificação (Node):

```js
import { createHmac, timingSafeEqual } from "node:crypto";
function valid(secret, rawBody, headers) {
  const esperado = "sha256=" + createHmac("sha256", secret).update(headers["x-webhook-timestamp"] + "." + rawBody).digest("hex");
  const a = Buffer.from(esperado), b = Buffer.from(headers["x-webhook-signature"] || "");
  return a.length === b.length && timingSafeEqual(a, b) && Math.abs(Date.now() / 1000 - Number(headers["x-webhook-timestamp"])) < 300;
}
```

## Segurança (faça antes de publicar)

- Coloque a API atrás de **HTTPS** (Caddy, Nginx, Traefik…). O `docker-compose.yml` só abre `127.0.0.1`.
- `SECRET` forte e fora do repositório; Postgres com senha própria e sem porta pública. Faça backup do banco: nele estão as credenciais do WhatsApp (cifradas).
- Chaves de API valem para tudo (sem níveis de permissão): dê uma por sistema e revogue com `update api_keys set revoked_at = now()`. Para um painel de usuários com perfis, construa-o por cima da API.
- O painel de demonstração guarda a chave no `localStorage` do navegador: serve para testar, não para entregar a clientes.
- Arquivos recebidos ficam em `MEDIA_DIR` (disco, sem criptografia em repouso). Para S3 ou outro armazenamento, troque as duas funções de `src/storage.ts`.
- Mensagens recebidas são gravadas direto no banco. Se o banco estiver fora do ar nesse momento, a mensagem daquele instante pode se perder (não há fila em disco).

## Limites conhecidos

- Grupos são ignorados por padrão (`INCLUDE_GROUPS=true` grava as mensagens, mas não há funções de administração de grupo).
- Sem histórico antigo: só vale o que chega depois de conectado.
- Sem envio de enquetes, botões ou listas, nem chamadas.
- O estado da fila de envio é por número: um número lento não atrasa os outros, mas cada um envia no máximo uma mensagem a cada `SEND_DELAY_MS`.

## Desenvolvimento

```bash
npm test          # testes (Postgres em memória, sem WhatsApp)
npm run typecheck
```

Estrutura: `src/service.ts` concentra as regras (usável direto se você embutir isto no seu app); `src/api.ts` só traduz HTTP.

## Licença

MIT. Baileys e o WhatsApp têm licenças e termos próprios; você é responsável pelo uso.
