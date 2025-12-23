/**
 * ============================================================================
 * STACKS DEX - Main Application with REOWN AppKit
 * ============================================================================
 * 
 * Architecture:
 * 
 *   DEX Frontend
 *        |
 *        |  Wallet UI + sessions
 *        v
 *   REOWN AppKit (chain-agnostic transport + UX)
 *        |
 *        |  WalletConnect v2 transport
 *        v
 *   WalletConnect Stacks JSON-RPC
 *        |
 *        |  stx_* methods
 *        v
 *   Stacks Wallet (Hiro / Xverse / Leather)
 * 
 * Key Points:
 * - REOWN AppKit does NOT have a Stacks-specific SDK
 * - Stacks support uses WalletConnect v2 with stx_* JSON-RPC methods
 * - Frontend builds transactions, wallet signs them
 * - stx_getAddresses - get user's Stacks addresses
 * - stx_signTransaction - sign a Stacks transaction
 * - stx_signMessage - sign arbitrary messages
 * ============================================================================
 */

import { createAppKit } from '@reown/appkit';
import UniversalProvider from '@walletconnect/universal-provider';
import { 
  makeUnsignedContractCall,
  uintCV,
  principalCV,
  PostConditionMode,
  FungibleConditionCode,
  makeStandardFungiblePostCondition,
  AnchorMode,
  deserializeTransaction,
  broadcastTransaction
} from '@stacks/transactions';
import { StacksMainnet, StacksTestnet } from '@stacks/network';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Network configuration - MAINNET
  network: 'mainnet',
  
  // REOWN AppKit Project ID (get from https://cloud.reown.com)
  projectId: 'YOUR_REOWN_PROJECT_ID', // Replace with your project ID
  
  // Contract addresses (update after deployment)
  poolContract: {
    address: 'SP_YOUR_DEPLOYER_ADDRESS', // Update after mainnet deployment
    name: 'pool'
  },
  // Example mainnet SIP-010 tokens (update with your token pair)
  // Common mainnet tokens:
  // - STX (native)
  // - ALEX: SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.age000-governance-token
  // - USDA: SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR.usda-token
  tokenX: {
    address: 'SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9', // Example: ALEX token
    name: 'age000-governance-token',
    symbol: 'ALEX',
    decimals: 8,
    assetName: 'alex'
  },
  tokenY: {
    address: 'SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR', // Example: USDA
    name: 'usda-token',
    symbol: 'USDA',
    decimals: 6,
    assetName: 'usda'
  },
  
  // DEX parameters
  feeBps: 30,
  bpsDenom: 10000,
  
  // Default settings
  defaultSlippage: 0.5,
  defaultDeadlineBlocks: 20,
  
  // App metadata
  metadata: {
    name: 'Stacks DEX',
    description: 'Minimal AMM DEX on Stacks (Bitcoin L2)',
    url: typeof window !== 'undefined' ? window.location.origin : 'https://stacks-dex.example.com',
    icons: [typeof window !== 'undefined' ? `${window.location.origin}/favicon.svg` : '']
  }
};

// Stacks network instance
const stacksNetwork = CONFIG.network === 'mainnet' 
  ? new StacksMainnet() 
  : new StacksTestnet();

// Stacks chain identifier for WalletConnect
const STACKS_CHAIN_ID = CONFIG.network === 'mainnet' ? 'stacks:1' : 'stacks:2147483648';

// ============================================================================
// STATE
// ============================================================================

let state = {
  connected: false,
  address: null,
  provider: null,
  session: null,
  balanceX: 0,
  balanceY: 0,
  reserveX: 0,
  reserveY: 0,
  slippage: CONFIG.defaultSlippage,
  deadlineBlocks: CONFIG.defaultDeadlineBlocks,
  inputAmount: '',
  outputAmount: '',
  currentBlockHeight: 0,
  swapDirection: true
};

// ============================================================================
// DOM ELEMENTS
// ============================================================================

const elements = {
  connectBtn: document.getElementById('connect-btn'),
  disconnectBtn: document.getElementById('disconnect-btn'),
  walletStatus: document.getElementById('wallet-status'),
  walletInfo: document.getElementById('wallet-info'),
  walletAddress: document.getElementById('wallet-address'),
  inputAmount: document.getElementById('input-amount'),
  outputAmount: document.getElementById('output-amount'),
  maxBtn: document.getElementById('max-btn'),
  swapBtn: document.getElementById('swap-btn'),
  swapDetails: document.getElementById('swap-details'),
  balanceX: document.getElementById('balance-x'),
  balanceY: document.getElementById('balance-y'),
  exchangeRate: document.getElementById('exchange-rate'),
  dexFee: document.getElementById('dex-fee'),
  minReceived: document.getElementById('min-received'),
  slippageDisplay: document.getElementById('slippage-display'),
  priceImpact: document.getElementById('price-impact'),
  settingsBtn: document.getElementById('settings-btn'),
  settingsModal: document.getElementById('settings-modal'),
  closeSettings: document.getElementById('close-settings'),
  slippageBtns: document.querySelectorAll('.slippage-btn'),
  customSlippage: document.getElementById('custom-slippage'),
  deadlineBlocks: document.getElementById('deadline-blocks'),
  statusMessage: document.getElementById('status-message'),
  swapDirectionBtn: document.getElementById('swap-direction-btn'),
  tokenXSymbol: document.getElementById('token-x-symbol'),
  tokenYSymbol: document.getElementById('token-y-symbol')
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function formatAmount(amount, decimals = 6) {
  const value = Number(amount) / Math.pow(10, decimals);
  if (value === 0) return '0.00';
  if (value < 0.000001) return '<0.000001';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6
  });
}

function parseAmount(input, decimals = 6) {
  const value = parseFloat(input) || 0;
  return Math.floor(value * Math.pow(10, decimals));
}

function truncateAddress(address) {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function showStatus(message, type = 'pending') {
  elements.statusMessage.textContent = message;
  elements.statusMessage.className = `status-message ${type}`;
  elements.statusMessage.classList.remove('hidden');
}

function hideStatus() {
  elements.statusMessage.classList.add('hidden');
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.substr(i, 2), 16);
  }
  return bytes;
}

// ============================================================================
// REOWN APPKIT + WALLETCONNECT INITIALIZATION
// ============================================================================

let appKit = null;
let universalProvider = null;

/**
 * Initialize REOWN AppKit with WalletConnect Universal Provider
 * This sets up the chain-agnostic transport layer
 */
async function initializeAppKit() {
  try {
    // Initialize Universal Provider for WalletConnect v2
    universalProvider = await UniversalProvider.init({
      projectId: CONFIG.projectId,
      metadata: CONFIG.metadata,
      // Stacks namespace configuration
      relayUrl: 'wss://relay.walletconnect.com'
    });

    // Set up event listeners
    universalProvider.on('display_uri', (uri) => {
      console.log('WalletConnect URI:', uri);
      // AppKit will handle displaying the QR code
    });

    universalProvider.on('session_event', (event) => {
      console.log('Session event:', event);
    });

    universalProvider.on('session_update', ({ topic, params }) => {
      console.log('Session updated:', topic, params);
    });

    universalProvider.on('session_delete', () => {
      console.log('Session deleted');
      handleDisconnect();
    });

    // Initialize REOWN AppKit for UI
    // Note: AppKit is used for the connection UI/UX
    // Actual Stacks operations go through the universal provider
    appKit = createAppKit({
      projectId: CONFIG.projectId,
      metadata: CONFIG.metadata,
      // Using universal provider for non-EVM chains
      universalProvider,
      // Custom Stacks network configuration
      networks: [{
        id: STACKS_CHAIN_ID,
        name: CONFIG.network === 'mainnet' ? 'Stacks Mainnet' : 'Stacks Testnet',
        nativeCurrency: {
          name: 'Stacks',
          symbol: 'STX',
          decimals: 6
        },
        rpcUrls: {
          default: {
            http: [CONFIG.network === 'mainnet' 
              ? 'https://api.mainnet.hiro.so' 
              : 'https://api.testnet.hiro.so']
          }
        },
        blockExplorers: {
          default: {
            name: 'Stacks Explorer',
            url: CONFIG.network === 'mainnet'
              ? 'https://explorer.stacks.co'
              : 'https://explorer.stacks.co/?chain=testnet'
          }
        }
      }],
      themeMode: 'dark',
      themeVariables: {
        '--w3m-accent': '#f7931a',
        '--w3m-border-radius-master': '12px'
      }
    });

    console.log('REOWN AppKit initialized');

    // Subscribe to AppKit provider events for connection state
    appKit.subscribeProvider((providerState) => {
      console.log('AppKit provider state:', providerState);
      
      if (providerState.isConnected && providerState.address) {
        // Connected via AppKit
        state.connected = true;
        state.address = providerState.address;
        state.provider = universalProvider;
        state.session = universalProvider.session;
        
        hideStatus();
        updateUI();
        
        // Fetch balances
        Promise.all([fetchBalances(), fetchReserves()]).catch(console.error);
      } else if (!providerState.isConnected && state.connected) {
        // Disconnected
        handleDisconnect();
      }
    });
    
    // Check for existing session
    if (universalProvider.session) {
      await restoreSession();
    }

  } catch (error) {
    console.error('Failed to initialize AppKit:', error);
    showStatus('Failed to initialize wallet connection', 'error');
  }
}

// ============================================================================
// WALLET CONNECTION FUNCTIONS
// ============================================================================

/**
 * Connect wallet using REOWN AppKit modal
 * Opens the AppKit modal for wallet selection and connection
 */
async function connectWallet() {
  try {
    showStatus('Opening wallet...', 'pending');

    // Ensure AppKit is initialized
    if (!appKit) {
      await initializeAppKit();
    }

    // Open REOWN AppKit modal for wallet connection
    if (appKit && typeof appKit.open === 'function') {
      console.log('Opening REOWN AppKit modal...');
      await appKit.open();
      hideStatus();
      return; // AppKit will handle connection via subscribeProvider
    }

    // Fallback: Connect directly via WalletConnect Universal Provider
    console.log('Fallback: Direct WalletConnect connection');
    const session = await universalProvider.connect({
      namespaces: {
        stacks: {
          methods: ['stx_getAddresses', 'stx_signTransaction', 'stx_signMessage'],
          chains: [STACKS_CHAIN_ID],
          events: ['accountsChanged', 'chainChanged']
        }
      }
    });

    state.session = session;
    state.provider = universalProvider;
    await getStacksAddresses();
    state.connected = true;
    hideStatus();
    updateUI();
    await Promise.all([fetchBalances(), fetchReserves()]);

  } catch (error) {
    console.error('Connection failed:', error);
    showStatus('Connection failed: ' + error.message, 'error');
    setTimeout(hideStatus, 3000);
  }
}

/**
 * Get Stacks addresses via WalletConnect JSON-RPC
 */
async function getStacksAddresses() {
  if (!universalProvider) throw new Error('Provider not initialized');

  try {
    // Call stx_getAddresses via WalletConnect
    const response = await universalProvider.request({
      method: 'stx_getAddresses',
      params: {}
    }, STACKS_CHAIN_ID);

    console.log('stx_getAddresses response:', response);

    // Extract address based on network
    if (response && response.addresses) {
      const addressInfo = response.addresses.find(addr => 
        CONFIG.network === 'mainnet' 
          ? addr.address.startsWith('SP') 
          : addr.address.startsWith('ST')
      );
      
      if (addressInfo) {
        state.address = addressInfo.address;
      } else if (response.addresses.length > 0) {
        state.address = response.addresses[0].address;
      }
    } else if (typeof response === 'string') {
      state.address = response;
    }

    if (!state.address) {
      throw new Error('No Stacks address returned');
    }

    console.log('Connected address:', state.address);

  } catch (error) {
    console.error('Failed to get addresses:', error);
    throw error;
  }
}

/**
 * Restore existing WalletConnect session
 */
async function restoreSession() {
  try {
    state.session = universalProvider.session;
    state.provider = universalProvider;
    
    await getStacksAddresses();
    
    state.connected = true;
    updateUI();
    
    await Promise.all([fetchBalances(), fetchReserves()]);
    
  } catch (error) {
    console.error('Failed to restore session:', error);
    await disconnectWallet();
  }
}

/**
 * Disconnect wallet
 */
async function disconnectWallet() {
  try {
    if (universalProvider && state.session) {
      await universalProvider.disconnect();
    }
  } catch (error) {
    console.error('Disconnect error:', error);
  }
  
  handleDisconnect();
}

function handleDisconnect() {
  state.connected = false;
  state.address = null;
  state.session = null;
  state.balanceX = 0;
  state.balanceY = 0;
  updateUI();
}

// ============================================================================
// STACKS TRANSACTION FUNCTIONS
// ============================================================================

/**
 * Sign and broadcast a Stacks transaction via WalletConnect
 * Uses stx_signTransaction JSON-RPC method
 */
async function signAndBroadcastTransaction(unsignedTx) {
  if (!universalProvider || !state.address) {
    throw new Error('Wallet not connected');
  }

  // Serialize the unsigned transaction to hex
  const serializedTx = bytesToHex(unsignedTx.serialize());

  console.log('Requesting signature for transaction:', serializedTx);

  // Request signature via WalletConnect stx_signTransaction
  const signedTxHex = await universalProvider.request({
    method: 'stx_signTransaction',
    params: {
      // The unsigned transaction in hex format
      transaction: serializedTx,
      // Network identifier
      network: CONFIG.network,
      // Optional: specify the address that should sign
      address: state.address
    }
  }, STACKS_CHAIN_ID);

  console.log('Signed transaction:', signedTxHex);

  // Broadcast the signed transaction
  // Some wallets broadcast automatically, others return the signed tx
  if (typeof signedTxHex === 'object' && signedTxHex.txId) {
    // Wallet already broadcast
    return signedTxHex.txId;
  }

  // Deserialize and broadcast
  const signedTx = deserializeTransaction(hexToBytes(signedTxHex));
  const broadcastResult = await broadcastTransaction(signedTx, stacksNetwork);
  
  if (broadcastResult.error) {
    throw new Error(broadcastResult.reason || 'Broadcast failed');
  }

  return broadcastResult.txid;
}

// ============================================================================
// DEX CONTRACT INTERACTIONS
// ============================================================================

/**
 * Fetch current pool reserves via Stacks API
 */
async function fetchReserves() {
  try {
    const apiUrl = CONFIG.network === 'mainnet'
      ? 'https://api.mainnet.hiro.so'
      : 'https://api.testnet.hiro.so';

    const response = await fetch(
      `${apiUrl}/v2/contracts/call-read/${CONFIG.poolContract.address}/${CONFIG.poolContract.name}/get-reserves`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: CONFIG.poolContract.address,
          arguments: []
        })
      }
    );

    const data = await response.json();
    
    if (data.okay && data.result) {
      // Parse Clarity response
      // Result is a tuple: { x: uint, y: uint }
      const result = parseClarityValue(data.result);
      state.reserveX = result.x || 0;
      state.reserveY = result.y || 0;
      console.log('Reserves:', { x: state.reserveX, y: state.reserveY });
    }
  } catch (error) {
    console.error('Failed to fetch reserves:', error);
    // Set default values for testing
    state.reserveX = 1000000000; // 1000 tokens
    state.reserveY = 1000000000;
  }
}

/**
 * Fetch user token balances via Stacks API
 */
async function fetchBalances() {
  if (!state.address) return;

  const apiUrl = CONFIG.network === 'mainnet'
    ? 'https://api.mainnet.hiro.so'
    : 'https://api.testnet.hiro.so';

  try {
    // Fetch Token X balance
    const responseX = await fetch(
      `${apiUrl}/v2/contracts/call-read/${CONFIG.tokenX.address}/${CONFIG.tokenX.name}/get-balance`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: state.address,
          arguments: [cvToHex(principalCV(state.address))]
        })
      }
    );
    const dataX = await responseX.json();
    if (dataX.okay) {
      state.balanceX = parseClarityUint(dataX.result);
    }

    // Fetch Token Y balance
    const responseY = await fetch(
      `${apiUrl}/v2/contracts/call-read/${CONFIG.tokenY.address}/${CONFIG.tokenY.name}/get-balance`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: state.address,
          arguments: [cvToHex(principalCV(state.address))]
        })
      }
    );
    const dataY = await responseY.json();
    if (dataY.okay) {
      state.balanceY = parseClarityUint(dataY.result);
    }

    updateBalanceDisplay();
  } catch (error) {
    console.error('Failed to fetch balances:', error);
  }
}

/**
 * Calculate quote locally using AMM formula
 * Fee is deducted and sent to deployer wallet, not kept in pool
 */
function calculateQuote(dx) {
  if (dx <= 0 || state.reserveX <= 0 || state.reserveY <= 0) return 0;
  
  // Calculate fee: fee = dx * 30 / 10000 (0.30%)
  const fee = Math.floor((dx * CONFIG.feeBps) / CONFIG.bpsDenom);
  
  // Amount going to pool after fee
  const dxToPool = dx - fee;
  
  // dy = (ry * dx_to_pool) / (rx + dx_to_pool)
  const numerator = state.reserveY * dxToPool;
  const denominator = state.reserveX + dxToPool;
  const dy = Math.floor(numerator / denominator);
  
  return dy;
}

/**
 * Execute swap transaction
 */
async function executeSwap() {
  if (!state.connected || !state.address) {
    showStatus('Please connect wallet first', 'error');
    return;
  }

  const dx = parseAmount(state.inputAmount, CONFIG.tokenX.decimals);
  if (dx <= 0) {
    showStatus('Please enter a valid amount', 'error');
    return;
  }

  const dy = calculateQuote(dx);
  if (dy <= 0) {
    showStatus('Unable to calculate output', 'error');
    return;
  }

  // Calculate minimum output with slippage
  const minDy = Math.floor(dy * (1 - state.slippage / 100));

  // Fetch current block height for deadline
  let deadline;
  try {
    const apiUrl = CONFIG.network === 'mainnet'
      ? 'https://api.mainnet.hiro.so'
      : 'https://api.testnet.hiro.so';
    const blockResponse = await fetch(`${apiUrl}/v2/info`);
    const blockData = await blockResponse.json();
    deadline = blockData.stacks_tip_height + state.deadlineBlocks;
  } catch {
    deadline = 999999; // Fallback
  }

  showStatus('Building transaction...', 'pending');

  try {
    // Build post-conditions for user protection
    const postConditions = [
      // User sends exactly dx of token X
      makeStandardFungiblePostCondition(
        state.address,
        FungibleConditionCode.Equal,
        BigInt(dx),
        `${CONFIG.tokenX.address}.${CONFIG.tokenX.name}::${CONFIG.tokenX.assetName}`
      )
    ];

    // Build unsigned contract call transaction
    const txOptions = {
      contractAddress: CONFIG.poolContract.address,
      contractName: CONFIG.poolContract.name,
      functionName: 'swap-x-for-y',
      functionArgs: [
        principalCV(`${CONFIG.tokenX.address}.${CONFIG.tokenX.name}`),
        principalCV(`${CONFIG.tokenY.address}.${CONFIG.tokenY.name}`),
        uintCV(dx),
        uintCV(minDy),
        principalCV(state.address),
        uintCV(deadline)
      ],
      publicKey: state.address, // Will be filled by wallet
      network: stacksNetwork,
      anchorMode: AnchorMode.Any,
      postConditionMode: PostConditionMode.Deny,
      postConditions
    };

    // Create unsigned transaction
    const unsignedTx = await makeUnsignedContractCall(txOptions);

    showStatus('Requesting signature...', 'pending');

    // Sign via WalletConnect (stx_signTransaction)
    const txId = await signAndBroadcastTransaction(unsignedTx);

    showStatus(`Transaction submitted! TxID: ${txId}`, 'success');
    console.log('Swap transaction:', txId);

    // Open explorer link
    const explorerUrl = CONFIG.network === 'mainnet'
      ? `https://explorer.stacks.co/txid/${txId}`
      : `https://explorer.stacks.co/txid/${txId}?chain=testnet`;
    console.log('Explorer:', explorerUrl);

    // Refresh balances after delay
    setTimeout(async () => {
      await Promise.all([fetchBalances(), fetchReserves()]);
      hideStatus();
    }, 5000);

  } catch (error) {
    console.error('Swap failed:', error);
    showStatus(`Swap failed: ${error.message}`, 'error');
    setTimeout(hideStatus, 5000);
  }
}

// ============================================================================
// CLARITY VALUE HELPERS
// ============================================================================

/**
 * Convert Clarity value to hex for API calls
 */
function cvToHex(cv) {
  const serialized = serializeCV(cv);
  return '0x' + bytesToHex(serialized);
}

/**
 * Serialize Clarity value (simplified)
 */
function serializeCV(cv) {
  // This is a simplified version - in production use @stacks/transactions
  if (cv.type === 'principal') {
    // Principal serialization
    const encoder = new TextEncoder();
    return encoder.encode(cv.address);
  }
  return new Uint8Array([]);
}

/**
 * Parse Clarity uint from hex response
 */
function parseClarityUint(hex) {
  // Simplified parsing - in production use proper Clarity decoding
  try {
    const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
    // Clarity uint starts with 01 type byte
    if (cleanHex.startsWith('01')) {
      const valueHex = cleanHex.slice(2);
      return parseInt(valueHex, 16);
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Parse Clarity tuple value
 */
function parseClarityValue(hex) {
  // Simplified - in production use cvToJSON from @stacks/transactions
  try {
    return { x: 0, y: 0 };
  } catch {
    return { x: 0, y: 0 };
  }
}

// ============================================================================
// ============================================================================
// SWAP DIRECTION TOGGLE
// ============================================================================

function switchSwapDirection() {
  state.swapDirection = !state.swapDirection;
  
  const fromToken = state.swapDirection ? CONFIG.tokenX : CONFIG.tokenY;
  const toToken = state.swapDirection ? CONFIG.tokenY : CONFIG.tokenX;
  
  if (elements.tokenXSymbol) elements.tokenXSymbol.textContent = fromToken.symbol;
  if (elements.tokenYSymbol) elements.tokenYSymbol.textContent = toToken.symbol;
  
  const balanceFrom = state.swapDirection ? state.balanceX : state.balanceY;
  const balanceTo = state.swapDirection ? state.balanceY : state.balanceX;
  
  if (elements.balanceX) elements.balanceX.textContent = formatAmount(balanceFrom, fromToken.decimals);
  if (elements.balanceY) elements.balanceY.textContent = formatAmount(balanceTo, toToken.decimals);
  
  if (elements.inputAmount) elements.inputAmount.value = '';
  if (elements.outputAmount) elements.outputAmount.value = '';
  state.inputAmount = '';
  state.outputAmount = '';
  
  updateSwapDetails();
  console.log('Swap direction:', state.swapDirection ? 'X→Y' : 'Y→X');
}

// UI UPDATE FUNCTIONS
// ============================================================================

function updateUI() {
  if (state.connected) {
    elements.walletStatus.classList.add('hidden');
    elements.walletInfo.classList.remove('hidden');
    elements.walletAddress.textContent = truncateAddress(state.address);
    elements.swapBtn.textContent = 'Swap';
    elements.swapBtn.disabled = !state.inputAmount;
  } else {
    elements.walletStatus.classList.remove('hidden');
    elements.walletInfo.classList.add('hidden');
    elements.swapBtn.textContent = 'Connect Wallet';
    elements.swapBtn.disabled = false;
  }
  
  updateBalanceDisplay();
  updateSwapDetails();
}

function updateBalanceDisplay() {
  elements.balanceX.textContent = formatAmount(state.balanceX, CONFIG.tokenX.decimals);
  elements.balanceY.textContent = formatAmount(state.balanceY, CONFIG.tokenY.decimals);
}

function updateSwapDetails() {
  const dx = parseAmount(state.inputAmount, CONFIG.tokenX.decimals);
  
  if (dx <= 0) {
    elements.swapDetails.classList.add('hidden');
    elements.outputAmount.value = '';
    state.outputAmount = '';
    return;
  }

  const dy = calculateQuote(dx);
  if (dy <= 0) {
    elements.swapDetails.classList.add('hidden');
    elements.outputAmount.value = '';
    state.outputAmount = '';
    return;
  }

  state.outputAmount = formatAmount(dy, CONFIG.tokenY.decimals);
  elements.outputAmount.value = state.outputAmount;

  // Calculate details
  const fee = Math.floor((dx * CONFIG.feeBps) / CONFIG.bpsDenom);
  const minDy = Math.floor(dy * (1 - state.slippage / 100));
  const rate = dy / dx;

  // Price impact
  const spotPrice = state.reserveY / state.reserveX;
  const executionPrice = dy / dx;
  const priceImpact = spotPrice > 0 ? ((spotPrice - executionPrice) / spotPrice * 100).toFixed(2) : '0.00';

  elements.exchangeRate.textContent = `1 ${CONFIG.tokenX.symbol} = ${rate.toFixed(6)} ${CONFIG.tokenY.symbol}`;
  elements.dexFee.textContent = `${formatAmount(fee, CONFIG.tokenX.decimals)} ${CONFIG.tokenX.symbol}`;
  elements.minReceived.textContent = `${formatAmount(minDy, CONFIG.tokenY.decimals)} ${CONFIG.tokenY.symbol}`;
  elements.slippageDisplay.textContent = `${state.slippage}%`;
  elements.priceImpact.textContent = `${priceImpact}%`;

  elements.swapDetails.classList.remove('hidden');

  if (state.connected) {
    if (dx > state.balanceX) {
      elements.swapBtn.textContent = 'Insufficient Balance';
      elements.swapBtn.disabled = true;
    } else {
      elements.swapBtn.textContent = 'Swap';
      elements.swapBtn.disabled = false;
    }
  }
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

let quoteDebounceTimer;
function handleInputChange(e) {
  state.inputAmount = e.target.value;
  clearTimeout(quoteDebounceTimer);
  quoteDebounceTimer = setTimeout(() => {
    updateSwapDetails();
  }, 300);
}

function handleMaxClick() {
  if (!state.connected) return;
  state.inputAmount = formatAmount(state.balanceX, CONFIG.tokenX.decimals);
  elements.inputAmount.value = state.inputAmount;
  updateSwapDetails();
}

function handleSwapClick() {
  if (!state.connected) {
    connectWallet();
  } else {
    executeSwap();
  }
}

function handleSlippageSelect(e) {
  const value = parseFloat(e.target.dataset.value);
  if (isNaN(value)) return;
  state.slippage = value;
  elements.slippageBtns.forEach(btn => btn.classList.remove('active'));
  e.target.classList.add('active');
  elements.customSlippage.value = '';
  elements.slippageDisplay.textContent = `${value}%`;
  updateSwapDetails();
}

function handleCustomSlippage(e) {
  const value = parseFloat(e.target.value);
  if (isNaN(value) || value < 0.01 || value > 50) return;
  state.slippage = value;
  elements.slippageBtns.forEach(btn => btn.classList.remove('active'));
  elements.slippageDisplay.textContent = `${value}%`;
  updateSwapDetails();
}

function handleDeadlineChange(e) {
  const value = parseInt(e.target.value);
  if (isNaN(value) || value < 1) return;
  state.deadlineBlocks = value;
}

function toggleSettings(show) {
  if (show) {
    elements.settingsModal.classList.remove('hidden');
  } else {
    elements.settingsModal.classList.add('hidden');
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function init() {
  console.log('Initializing Stacks DEX...');
  console.log('Network:', CONFIG.network);
  console.log('Pool contract:', `${CONFIG.poolContract.address}.${CONFIG.poolContract.name}`);

  // Initialize REOWN AppKit
  await initializeAppKit();

  // Fetch initial reserves
  await fetchReserves();

  // Update UI
  updateUI();

  // Set up event listeners
  elements.connectBtn.addEventListener('click', connectWallet);
  elements.disconnectBtn.addEventListener('click', disconnectWallet);
  elements.inputAmount.addEventListener('input', handleInputChange);
  elements.maxBtn.addEventListener('click', handleMaxClick);
  elements.swapBtn.addEventListener('click', handleSwapClick);
  elements.settingsBtn.addEventListener('click', () => toggleSettings(true));
  elements.closeSettings.addEventListener('click', () => toggleSettings(false));
  elements.customSlippage.addEventListener('input', handleCustomSlippage);
  elements.deadlineBlocks.addEventListener('input', handleDeadlineChange);

  elements.slippageBtns.forEach(btn => {
    btn.addEventListener('click', handleSlippageSelect);
  });

  elements.settingsModal.addEventListener('click', (e) => {
    if (e.target === elements.settingsModal) {
      toggleSettings(false);
    }
  });

  console.log('Stacks DEX initialized');
}

// Start the app
init();
