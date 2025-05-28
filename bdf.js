require('dotenv').config();


const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid'); // Para gerar UUIDs
const os = require('os');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const PORT = 3221;
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const dns = require('node:dns');
const cors = require('cors');


const valor = parseFloat(process.env.VALOR);

app.use(cors({
    origin: '*', // Permite qualquer origem (Ajuste para maior segurança se necessário)
    methods: ['GET', 'POST'], // Métodos permitidos
    allowedHeaders: ['Content-Type', 'Authorization'], // Cabeçalhos permitidos
}));

const options = { family: 4 };

dns.lookup(os.hostname(), options, (err, addr) => {
  if (err) {
    console.error(err);
  } else {
    console.log(`IPv4 address: ${addr}`);
  }
});

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_BASE,
    port: process.env.DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
});

async function executeQuery(query, values) {
    const connection = await pool.getConnection();
    try {
        const [rows] = await connection.execute(query, values);
        return rows;
    } catch (error) {
        console.error("Erro na query MySQL:", error);
        throw error;
    } finally {
        connection.release();
    }
}

async function insertTransaction(transaction_id, time, cpf, email, valor, status, numero) {
    try {
      // Insere a transação
        await executeQuery(
            'INSERT INTO transactions (transaction_id, time, cpf, email, valor, status, numero) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [transaction_id, time, cpf, email, valor, status, numero]
        );

        console.log(`Transação inserida com sucesso!`);
    } catch (error) {
        console.error('Erro ao inserir transação:', error);
    }
}

async function getNumeroByTransactionId(transaction_id) {
    try {
        const rows = await executeQuery(
            'SELECT numero FROM transactions WHERE transaction_id = ?',
            [transaction_id]
        );

        if (rows.length > 0) {
            return rows[0].numero;
        } else {
            console.log(`Nenhuma transação encontrada para o ID: ${transaction_id}`);
            return null;
        }
    } catch (error) {
        console.error('Erro ao buscar número pela transaction_id:', error);
        throw error;
    }
}

async function adicionarTelefoneNaPlanilha(telefone) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      type: 'service_account',
      project_id: process.env.GOOGLE_PROJECT_ID,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'Contatos!A:A', // Nome da aba + coluna A
    valueInputOption: 'RAW',
    resource: {
      values: [[telefone]],
    },
  });

  console.log(`✅ Telefone ${telefone} adicionado à planilha.`);
}

// Rota para gerar pagamento Pix
app.post('/generate-pix', async (req, res) => {
    try {
        
        const { cpf, emailPix, numero } = req.body;
        const idempotencyKey = uuidv4();
        const paymentData = {
            transaction_amount: valor, // Valor do pagamento em reais (ex: 100 para R$100,00)
            description: 'Pagamento via Pix',
            payment_method_id: 'pix',
            payer: {
                email: emailPix,
                first_name: ' ',
                last_name: ' ',
                identification: {
                    type: 'CPF',
                    number: cpf,
                },
            },
            external_reference: "", // Referência externa vinculada ao MAC Address
        };

        console.log('Requisição recebida para pagamento Pix:', paymentData);

        // Faz a requisição para a API do Mercado Pago
        const response = await axios.post('https://api.mercadopago.com/v1/payments', paymentData, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
                'X-Idempotency-Key': idempotencyKey,
            },
        });

        const pixCode = response.data.point_of_interaction.transaction_data.qr_code;
        const transactionId = response.data.id; // Obtém a transaction ID da resposta
        const now = new Date();
        const formattedTime = new Intl.DateTimeFormat('pt-BR', { 
            year: 'numeric', 
            month: '2-digit', 
            day: '2-digit', 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit', 
            hour12: false,
            timeZone: 'America/Sao_Paulo' // Define o fuso horário do Brasil
        }).format(now).replace(',', '');
        // Ajustar o formato para MySQL (YYYY-MM-DD HH:MM:SS)
        const [date, time] = formattedTime.split(' ');
        const [day, month, year] = date.split('/');
        const brasilTime = `${year}-${month}-${day} ${time}`;
        insertTransaction(transactionId, brasilTime, cpf, emailPix, valor, 'enviado ao MP', numero);
        // Retorna o QR Code Pix e a Transaction ID
        res.json({ pixCode, transactionId });
    } catch (error) {
        console.error('Erro ao gerar pagamento Pix:', error.response ? error.response.data : error.message);
        res.status(error.response?.status || 500).json({ error: error.response?.data || error.message });
    }
});



// Middleware para processar JSON
app.use(bodyParser.json());
// Endpoint para receber notificações do Mercado Pago
app.post('/payment-notification', async (req, res) => {
    try {
        console.log("🔔 Notificação do Mercado Pago recebida!");

        // Verifica se o conteúdo enviado é JSON
        if (!req.is('application/json')) {
            return res.status(400).json({ success: false, message: "Conteúdo inválido" });
        }

        const { action, type, data } = req.body;
        const paymentId = data?.id;

        // Validação básica dos dados recebidos
        if (!action || !type || !paymentId) {
            console.log(" Dados incompletos recebidos na notificação.");
            return res.status(400).json({ success: false, message: "Dados incompletos" });
        }

        console.log(`🔹 Ação: ${action}, Tipo: ${type}, ID do pagamento: ${paymentId}`);

        // Processamento apenas para notificações de pagamento
        if (type === "payment") {
            console.log(` Buscando status do pagamento no Mercado Pago: ${paymentId}`);

            // Busca o status do pagamento na API do Mercado Pago
            const response = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                headers: {
                    "Authorization": `Bearer ${process.env.MP_ACCESS_TOKEN}`
                }
            });

            const paymentData = response.data;
            const statusPagamento = paymentData.status;
            //const unit = getUnitByTransactionId(paymentId)
            console.log(` Status do pagamento ${paymentId}: ${statusPagamento}`);

            // Atualiza o status da transação no banco de dados
            //await executeQuery(
            //    `UPDATE transactions SET status = ? WHERE transaction_id = ?`,
            //    [statusPagamento, paymentId]
            //
            // );
            


            console.log(` Transação ${paymentId} atualizada no banco de dados.`);

            // Se o pagamento foi aprovado, libera o MAC
            if (statusPagamento === "approved") {
                console.log(`🎉 Pagamento aprovado!`);
                const numero = await getNumeroByTransactionId(paymentId);
                console.log("Número encontrado:", numero);
                adicionarTelefoneNaPlanilha(numero)
            }
        } else {
            console.log(` Notificação ignorada. Tipo: ${type}, Ação: ${action}`);
        }

        // Responde ao Mercado Pago que a notificação foi processada com sucesso
        res.status(200).json({ success: true, message: "Notificação processada com sucesso" });

    } catch (error) {
        console.error(" Erro ao processar notificação:", error);
        res.status(500).json({ success: false, message: "Erro ao processar notificação" });
    }
});


// Inicia o servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando em ${PORT}`);
});
