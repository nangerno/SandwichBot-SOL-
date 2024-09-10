require('dotenv').config();
const axios = require('axios'); // Import axios for HTTP requests
const { Connection, PublicKey, Transaction, SystemProgram, Keypair, TransactionInstruction } = require('@solana/web3.js');
const bs58 = require('bs58');
const winston = require('winston');
const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } = require("@solana/spl-token");

// Set up logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

logger.info('Starting Solana Sandwich Bot');

// RPC endpoint
const rpcEndpoint = 'http://texas.deez.top:80/';  // Updated RPC endpoint

logger.info('Initialized RPC endpoint');

// Initialize Solana connection
const connection = new Connection(rpcEndpoint, {
  commitment: 'confirmed',
  maxSupportedTransactionVersion: 0,
});

// Load wallet
logger.info('Loading wallet');
const secretKey = bs58.decode(process.env.PRIVATE_KEY);
const wallet = Keypair.fromSecretKey(secretKey);
logger.info(`Wallet public key: ${wallet.publicKey.toBase58()}`);

// Raydium Standard AMM Program ID
const RAYDIUM_STANDARD_AMM_PROGRAM_ID = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");

// Define the checkWalletBalance function
async function checkWalletBalance() {
  try {
    const balance = await connection.getBalance(wallet.publicKey);
    logger.info(`Wallet balance: ${balance}`);
    if (balance < 1000000) { // Ensure there is at least 0.001 SOL
      throw new Error('Insufficient funds in wallet');
    }
  } catch (error) {
    logger.error(`Error checking wallet balance: ${error.message}`);
    throw error;
  }
}

// Fetch trending tokens based on 24-hour volume (USD) from BirdEye
async function getTrendingTokens() {
  try {
    logger.info("Fetching trending tokens from BirdEye API...");
    const response = await axios.get('https://public-api.birdeye.so/defi/tokenlist', {
      headers: {
        'X-API-KEY': '53d01fc8aa2241e7896c8bc4184f05ca',
      },
      params: {
        sort_by: 'v24hUSD',  // Sorting by 24-hour volume in USD
        sort_type: 'desc',
        limit: 50,  // Adjust the number of trending tokens to fetch
      },
    });

    // Log the entire response data to inspect its structure
    logger.info("API response data:", JSON.stringify(response.data, null, 2));

    // Correctly map over the data.tokens array to get the token addresses
    if (response.data && response.data.data && Array.isArray(response.data.data.tokens)) {
      const trendingTokens = response.data.data.tokens.map(token => token.address);
      logger.info(`Fetched ${trendingTokens.length} trending tokens based on 24-hour volume from BirdEye`);
      return trendingTokens;
    } else {
      logger.error(`Unexpected response structure: ${JSON.stringify(response.data, null, 2)}`);
      throw new Error("Unexpected response structure from BirdEye API");
    }
  } catch (error) {
    logger.error(`Error fetching trending tokens: ${error.message}`);
    if (error.response && error.response.data) {
      logger.error(`Response data: ${JSON.stringify(error.response.data, null, 2)}`);
    }
    throw error;
  }
}

// Function to send transactions
async function sendTransaction(transaction) {
  try {
    logger.info('Simulating transaction...');
    
    // Set the fee payer for the transaction
    transaction.feePayer = wallet.publicKey;

    const simulationResult = await connection.simulateTransaction(transaction);
    if (simulationResult.value.err) {
      throw new Error(`Transaction simulation failed: ${JSON.stringify(simulationResult.value.err)}`);
    }
    logger.info('Simulation successful, sending transaction...');
    
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;

    transaction.sign(wallet);
    const serializedTransaction = transaction.serialize();

    const signature = await connection.sendRawTransaction(serializedTransaction);
    await connection.confirmTransaction(signature, 'confirmed');
    logger.info(`Transaction sent with signature: ${signature}`);
  } catch (error) {
    if (error.logs) {
      logger.error(`Error sending transaction: Simulation failed with logs: ${error.logs}`);
    } else {
      logger.error(`Error sending transaction: ${error.message}`);
    }
    throw error;
  }
}

// Function to interact with Raydium for a swap
async function executeRaydiumSwap(wallet, connection, amount, tokenMintAddress) {
  logger.info('Executing Raydium swap...');
  try {
    // Define the associated token account for the given token
    const tokenAccount = await getAssociatedTokenAddress(
      new PublicKey(tokenMintAddress),
      wallet.publicKey,
      false, // Is it the wallet's associated account?
      TOKEN_PROGRAM_ID
    );

    logger.info('Constructing Raydium swap instruction...');
    // Construct the Raydium swap instruction
    const swapInstruction = new TransactionInstruction({
      programId: RAYDIUM_STANDARD_AMM_PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
        // Add other necessary accounts for the Raydium swap here
      ],
      data: Buffer.from([]), // Data for the swap (Raydium-specific)
    });

    // Create and send the transaction
    const transaction = new Transaction().add(swapInstruction);
    logger.info('Sending swap transaction...');
    await sendTransaction(transaction);
    logger.info('Raydium swap executed successfully.');
  } catch (error) {
    logger.error(`Error executing Raydium swap: ${error.message}`);
    throw error;
  }
}

// Function to scan mempool and search for trending token transactions
async function scanMempool(trendingTokens) {
  if (trendingTokens.length === 0) {
    logger.info('No trending tokens to monitor.');
    return;
  }

  connection.onLogs('all', async (logs, ctx) => {
    try {
      const signature = logs.signature;
      logger.info(`Transaction detected: ${signature}`);
      const transaction = await connection.getParsedTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      if (transaction) {
        logger.info(`Detected relevant transaction with a trending token, proceeding with sandwich attack.`);
        await executeSandwichAttack(transaction, trendingTokens);
      }
    } catch (error) {
      logger.error(`Error: ${error.message}`);
    }
  });
}

// Function to execute sandwich attack using Raydium
async function executeSandwichAttack(transaction, trendingTokens) {
  try {
    logger.info('Starting to execute sandwich attack...');
    if (!transaction.transaction || !transaction.transaction.message || !transaction.transaction.message.accountKeys) {
      throw new Error('Invalid transaction structure: accountKeys not found');
    }

    const involvedAccounts = transaction.transaction.message.accountKeys.map(keyObj => new PublicKey(keyObj.pubkey));
    
    logger.info(`Involved accounts in transaction: ${involvedAccounts.map(acc => acc.toBase58()).join(', ')}`);
    
    // Check if transaction involves any trending tokens
    const involvesTrendingToken = involvedAccounts.some(key => trendingTokens.includes(key.toBase58()));
    
    if (!involvesTrendingToken) {
      logger.info('Transaction does not involve trending tokens, skipping...');
      return;
    }

    logger.info('Detected relevant transaction with a trending token, proceeding with front-run and back-run.');

    // Front-run: Execute swap on Raydium
    logger.info('Executing front-run transaction...');
    await executeRaydiumSwap(wallet, connection, 1000, trendingTokens[0]); // Example amount to swap

    // Back-run: Swap back on Raydium or another appropriate operation
    logger.info('Executing back-run transaction...');
    await executeRaydiumSwap(wallet, connection, 1000, trendingTokens[0]); // Example amount to swap back

    logger.info(`Sandwich attack executed on transaction: ${transaction.transaction.signatures[0]}`);
  } catch (error) {
    logger.error(`Error executing sandwich attack: ${error.message}`);
  }
}

// Wrap the main logic in an async function
async function main() {
  logger.info('Checking wallet balance...');
  await checkWalletBalance();
  logger.info('Fetching trending tokens...');
  const trendingTokens = await getTrendingTokens();
  logger.info('Scanning mempool...');
  scanMempool(trendingTokens);
}

// Call the main function
main().catch(error => {
  logger.error(`Error in main execution: ${error.message}`);
});

