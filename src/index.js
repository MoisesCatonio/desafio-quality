const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(cors());

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || 'postgres',
  database: process.env.DB_NAME || 'pedidos_db',
  port: 5432,
});

// Rota POST /order - Criar novo pedido com mapeamento, ajuste de sufixo e transação
app.post('/order', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const body = req.body;

    // 1. Validação básica de Schema
    if (!body || !body.numeroPedido || !body.items || !Array.isArray(body.items) || body.items.length === 0) {
      return res.status(400).json({ 
        error: 'Payload inválido. Certifique-se de enviar "numeroPedido", "valorTotal", "dataCriacao" e um array de "items".' 
      });
    }

    // 2. Transformação / Mapping dos dados (Incluindo a remoção do sufixo do numeroPedido, ex: "-01")
    const rawOrderId = String(body.numeroPedido);
    const cleanedOrderId = rawOrderId.includes('-') ? rawOrderId.split('-')[0] : rawOrderId;

    const mappedOrder = {
      orderId: cleanedOrderId,
      value: Number(body.valorTotal),
      creationDate: new Date(body.dataCriacao),
      items: body.items.map(item => ({
        productId: Number(item.idItem),
        quantity: Number(item.quantidadeItem),
        price: Number(item.valorItem)
      }))
    };

    // 3. Início da Transação SQL
    await client.query('BEGIN');

    const orderQuery = `
      INSERT INTO public."order" ("orderId", "value", "creationDate") 
      VALUES ($1, $2, $3)
    `;
    await client.query(orderQuery, [
      mappedOrder.orderId, 
      mappedOrder.value, 
      mappedOrder.creationDate
    ]);

    const itemQuery = `
      INSERT INTO public."items" ("orderId", "productId", "quantity", "price") 
      VALUES ($1, $2, $3, $4)
    `;

    for (const item of mappedOrder.items) {
      await client.query(itemQuery, [
        mappedOrder.orderId, 
        item.productId, 
        item.quantity, 
        item.price
      ]);
    }

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'Pedido criado com sucesso!',
      data: mappedOrder
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao criar pedido:', error);

    if (error.code === '23505') {
      return res.status(409).json({ error: 'Já existe um pedido cadastrado com este número.' });
    }

    return res.status(500).json({ error: 'Erro interno ao processar o pedido.' });
  } finally {
    client.release();
  }
});

// Rota GET /order/list - Listar todos os pedidos
app.get('/order/list', async (req, res) => {
  try {
    // 1. Buscar todos os pedidos
    const ordersResult = await pool.query(
      'SELECT "orderId", "value", "creationDate" FROM public."order"'
    );

    if (ordersResult.rows.length === 0) {
      return res.status(200).json([]);
    }

    // 2. Para cada pedido, buscar seus itens (ou podemos fazer com JOIN / subquery, mas para clareza vamos mapear)
    const ordersList = [];

    for (const order of ordersResult.rows) {
      const itemsResult = await pool.query(
        'SELECT "productId", "quantity", "price" FROM public."items" WHERE "orderId" = $1',
        [order.orderId]
      );

      ordersList.push({
        orderId: order.orderId,
        value: Number(order.value),
        creationDate: order.creationDate,
        items: itemsResult.rows.map(item => ({
          productId: item.productId,
          quantity: item.quantity,
          price: Number(item.price)
        }))
      });
    }

    return res.status(200).json(ordersList);

  } catch (error) {
    console.error('Erro ao listar pedidos:', error);
    return res.status(500).json({ error: 'Erro interno ao listar os pedidos.' });
  }
});

// Rota GET /order/:id - Obter um pedido específico pelo número
app.get('/order/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // 1. Buscar o pedido principal
    const orderResult = await pool.query(
      'SELECT "orderId", "value", "creationDate" FROM public."order" WHERE "orderId" = $1',
      [id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }

    const order = orderResult.rows[0];

    // 2. Buscar os itens pertencentes a este pedido
    const itemsResult = await pool.query(
      'SELECT "productId", "quantity", "price" FROM public."items" WHERE "orderId" = $1',
      [id]
    );

    // 3. Montar a resposta combinada no formato padrão
    const responsePayload = {
      orderId: order.orderId,
      value: Number(order.value),
      creationDate: order.creationDate,
      items: itemsResult.rows.map(item => ({
        productId: item.productId,
        quantity: item.quantity,
        price: Number(item.price)
      }))
    };

    return res.status(200).json(responsePayload);

  } catch (error) {
    console.error('Erro ao buscar pedido:', error);
    return res.status(500).json({ error: 'Erro interno ao buscar o pedido.' });
  }
});

// Rota PUT /order/:id - Atualizar um pedido existente com mapeamento e limpeza de ID
app.put('/order/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();

  try {
    const body = req.body;

    // 1. Validação básica de Schema
    if (!body || !body.valorTotal || !body.items || !Array.isArray(body.items) || body.items.length === 0) {
      return res.status(400).json({ 
        error: 'Payload inválido para atualização. Envie "valorTotal", "dataCriacao" e o array de "items".' 
      });
    }

    // 2. Limpeza do ID da URL caso também venha com sufixo
    const rawOrderId = String(id);
    const cleanedOrderId = rawOrderId.includes('-') ? rawOrderId.split('-')[0] : rawOrderId;

    // 3. Mapeamento dos novos dados com normalização de tipos
    const mappedOrder = {
      orderId: cleanedOrderId,
      value: Number(body.valorTotal),
      creationDate: new Date(body.dataCriacao || Date.now()),
      items: body.items.map(item => ({
        productId: Number(item.idItem),
        quantity: Number(item.quantidadeItem),
        price: Number(item.valorItem)
      }))
    };

    // 4. Início da Transação
    await client.query('BEGIN');

    // Verificar se o pedido existe (buscando pelo ID limpo)
    const checkOrder = await client.query('SELECT "orderId" FROM public."order" WHERE "orderId" = $1', [cleanedOrderId]);
    if (checkOrder.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pedido não encontrado para atualização.' });
    }

    // Atualizar dados principais do pedido
    await client.query(
      'UPDATE public."order" SET "value" = $1, "creationDate" = $2 WHERE "orderId" = $3',
      [mappedOrder.value, mappedOrder.creationDate, cleanedOrderId]
    );

    // Substituir os itens antigos pelos novos atualizados
    await client.query('DELETE FROM public."items" WHERE "orderId" = $1', [cleanedOrderId]);

    const itemQuery = `
      INSERT INTO public."items" ("orderId", "productId", "quantity", "price") 
      VALUES ($1, $2, $3, $4)
    `;

    for (const item of mappedOrder.items) {
      await client.query(itemQuery, [cleanedOrderId, item.productId, item.quantity, item.price]);
    }

    await client.query('COMMIT');

    return res.status(200).json({
      message: 'Pedido atualizado com sucesso!',
      orderId: cleanedOrderId,
      data: mappedOrder
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao atualizar pedido:', error);
    return res.status(500).json({ error: 'Erro interno ao atualizar o pedido.' });
  } finally {
    client.release();
  }
});

// Rota DELETE /order/:id - Deletar um pedido
app.delete('/order/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // Como configuramos "ON DELETE CASCADE" na tabela Items, deletar a order apaga os itens automaticamente
    const result = await pool.query('DELETE FROM public."order" WHERE "orderId" = $1 RETURNING "orderId"', [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Pedido não encontrado para exclusão.' });
    }

    return res.status(200).json({ message: `Pedido ${id} deletado com sucesso!` });

  } catch (error) {
    console.error('Erro ao deletar pedido:', error);
    return res.status(500).json({ error: 'Erro interno ao deletar o pedido.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});