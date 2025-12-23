/**
 * ==============================================================================
 * STACKS DEX - Main Application with REOWN AppKit + Browser Extension Support
 * ==============================================================================
 * 
 * Architecture (per ChatGPT guidance):
 * 
 *   DEX Frontend
 *        |
 *        |  Wallet UI + sessions
 *        v
 *   REOWN AppKit / WalletKit (chain-agnostic transport + UX)
 *        |
 *        +---> Browser Extension Provider (Leather/Xverse)
 *        |        |
 *        |        v window.LeatherProvider / window.XverseProviders
 *        |
 *        +---> WalletConnect v2 transport (for mobile)
 *                 |
 *                 v stx_* JSON-RPC methods
 * 
 * Key Points:
 * - REOWN AppKit does NOT have a Stacks-specific SDK
 * - Browser extensions (Leather) use their own provider APIs
 * - WalletConnect v2 uses stx_* JSON-RPC methods for mobile
 * - Frontend builds transactions, wallet signs them
 * ==============================================================================
 */

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
  broadcastTransaction,
  createAssetInfo
} from '@stacks/transactions';
import { StacksMainnet, StacksTestnet } from '@stacks/network';

// ==============================================================================
// CONFIGURATION
// ==============================================================================

const CONFIG = {
  // Network configuration - MAINNET
  network: 'mainnet',
  
  // REOWN AppKit Project ID
  projectId: '904d5b805622ae67732d359178980e74',
  
  // Pool contract
  poolContract: {
    address: 'SP31G2FZ5JN87BATZMP4ZRYE5F7WZQDNEXJ7G7X97',
    name: 'pool'
  },
  
  // Token pair
  tokenX: {
    address: 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM',
    name: 'token-alex',
    symbol: 'ALEX',
    decimals: 8,
    assetName: 'alex'
  },
  tokenY: {
    address: 'SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR',
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

// ==============================================================================
// STATE
// ==============================================================================

let state = {
  connected: false,
  address: null,
  provider: null,
  providerType: null, // 'leather', 'xverse', 'walletconnect'
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
  swapDirection: true // true = X->Y, false = Y->X
};

// ==============================================================================
// DOM ELEMENTS
// ==============================================================================

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

// ==============================================================================
// UTILITY FUNCTIONS
// ==============================================================================

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

// ==============================================================================
// WALLET DETECTION
// ==============================================================================

/**
 * Detect available wallet providers
 */
function detectWallets() {
  const wallets = [];
  
  // Check for Leather (browser extension)
  if (typeof window !== 'undefined' && window.LeatherProvider) {
    wallets.push({ id: 'leather', name: 'Leather', icon: '🦊', provider: window.LeatherProvider });
  }
  
  // Check for Xverse (browser extension)
  if (typeof window !== 'undefined' && (window.XverseProviders?.StacksProvider || window.btc)) {
    wallets.push({ id: 'xverse', name: 'Xverse', icon: '🟠', provider: window.XverseProviders?.StacksProvider });
  }
  
  // WalletConnect is always available as fallback
  wallets.push({ id: 'walletconnect', name: 'WalletConnect', icon: '🔗', provider: null });
  
  return wallets;
}

// ==============================================================================
// WALLET MODAL UI
// ==============================================================================

let universalProvider = null;

/**
 * Show wallet selection modal
 */
function showWalletModal() {
  const wallets = detectWallets();
  
  // Create modal
  let modal = document.getElementById('wallet-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'wallet-modal';
    modal.className = 'wallet-modal';
    document.body.appendChild(modal);
    
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeWalletModal();
    });
  }
  
  // Build wallet list
  const walletList = wallets.map(w => `
    <button class="wallet-option" data-wallet="${w.id}">
      <span class="wallet-icon">${w.icon}</span>
      <span class="wallet-name">${w.name}</span>
      ${w.id !== 'walletconnect' ? '<span class="wallet-badge">Detected</span>' : '<span class="wallet-badge secondary">QR Code</span>'}
    </button>
  `).join('');
  
  modal.innerHTML = `
    <div class="wallet-modal-content">
      <div class="wallet-modal-header">
        <h3>Connect Wallet</h3>
        <button class="wallet-close-btn" onclick="closeWalletModal()">&times;</button>
      </div>
      <div class="wallet-modal-body">
        <p class="wallet-subtitle">Select a wallet to connect</p>
        <div class="wallet-list">
          ${walletList}
        </div>
      </div>
    </div>
  `;
  
  modal.style.display = 'flex';
  
  // Attach click handlers
  modal.querySelectorAll('.wallet-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const walletId = btn.dataset.wallet;
      closeWalletModal();
      connectWithWallet(walletId);
    });
  });
}

function closeWalletModal() {
  const modal = document.getElementById('wallet-modal');
  if (modal) modal.style.display = 'none';
}

// Make globally accessible
window.closeWalletModal = closeWalletModal;

// ==============================================================================
// LEATHER WALLET CONNECTION (Browser Extension)
// ==============================================================================

async function connectWithLeather() {
  if (!window.LeatherProvider) {
    throw new Error('Leather wallet not installed. Please install from leather.io');
  }
  
  showStatus('Connecting to Leather...', 'pending');
  
  try {
    // Request addresses using Leather's API
    const response = await window.LeatherProvider.request('getAddresses');
    console.log('Leather response:', response);
    
    if (response.result && response.result.addresses) {
      // Find Stacks address
      const stacksAddress = response.result.addresses.find(addr => 
        addr.symbol === 'STX' && 
        (CONFIG.network === 'mainnet' ? addr.address.startsWith('SP') : addr.address.startsWith('ST'))
      );
      
      if (stacksAddress) {
        state.address = stacksAddress.address;
        state.provider = window.LeatherProvider;
        state.providerType = 'leather';
        state.connected = true;
        
        hideStatus();
        showStatus('Connected to Leather!', 'success');
        setTimeout(hideStatus, 2000);
        
        updateUI();
        await Promise.all([fetchBalances(), fetchReserves()]);
        return;
      }
    }
    
    throw new Error('No Stacks address found in Leather wallet');
    
  } catch (error) {
    console.error('Leather connection error:', error);
    throw error;
  }
}

/**
 * Execute contract call with Leather using stx_callContract
 */
async function executeWithLeather(swapParams) {
  const { functionName, amountIn, minAmountOut, deadline, inputToken, outputToken, postConditions } = swapParams;
  
  // Serialize post-condition to hex for the wallet
  // Leather handles post-conditions differently
  const response = await window.LeatherProvider.request('stx_callContract', {
    contract: `${CONFIG.poolContract.address}.${CONFIG.poolContract.name}`,
    functionName: functionName,
    functionArgs: [
      { type: 'uint128', value: amountIn.toString() },
      { type: 'uint128', value: minAmountOut.toString() },
      { type: 'uint128', value: deadline.toString() },
      { type: 'principal', value: `${inputToken.address}.${inputToken.name}` },
      { type: 'principal', value: `${outputToken.address}.${outputToken.name}` }
    ],
    network: CONFIG.network,
    postConditionMode: 'deny',
    postConditions: [
      {
        type: 'ft-postcondition',
        address: state.address,
        conditionCode: 'eq',
        amount: amountIn.toString(),
        asset: `${inputToken.address}.${inputToken.name}::${inputToken.assetName}`
      }
    ]
  });
  
  console.log('Leather contract call response:', response);
  
  if (response.result) {
    if (response.result.txid) {
      return response.result.txid;
    }
    if (response.result.txId) {
      return response.result.txId;
    }
  }
  
  throw new Error('Contract call failed');
}

/**
 * Sign pre-built transaction with Leather (fallback)
 */
async function signWithLeather(unsignedTx) {
  const serializedTx = bytesToHex(unsignedTx.serialize());
  
  const response = await window.LeatherProvider.request('stx_signTransaction', {
    transaction: serializedTx,
    network: CONFIG.network
  });
  
  console.log('Leather sign response:', response);
  
  if (response.result) {
    if (response.result.txId || response.result.txid) {
      return response.result.txId || response.result.txid;
    }
    const signedTxHex = response.result.transaction || response.result;
    const signedTx = deserializeTransaction(hexToBytes(signedTxHex));
    const broadcastResult = await broadcastTransaction(signedTx, stacksNetwork);
    
    if (broadcastResult.error) {
      throw new Error(broadcastResult.reason || 'Broadcast failed');
    }
    return broadcastResult.txid;
  }
  
  throw new Error('Signing failed');
}

// ==============================================================================
// XVERSE WALLET CONNECTION (Browser Extension)
// ==============================================================================

async function connectWithXverse() {
  // Xverse uses sats-connect library or direct provider
  showStatus('Connecting to Xverse...', 'pending');
  
  try {
    // Try using the direct provider first
    let provider = window.XverseProviders?.StacksProvider;
    
    if (!provider) {
      throw new Error('Xverse wallet not installed. Please install from xverse.app');
    }
    
    const response = await provider.request('getAddresses', {
      purposes: ['stacks']
    });
    
    console.log('Xverse response:', response);
    
    if (response.result && response.result.addresses) {
      const stacksAddress = response.result.addresses.find(addr => 
        addr.purpose === 'stacks' &&
        (CONFIG.network === 'mainnet' ? addr.address.startsWith('SP') : addr.address.startsWith('ST'))
      );
      
      if (stacksAddress) {
        state.address = stacksAddress.address;
        state.provider = provider;
        state.providerType = 'xverse';
        state.connected = true;
        
        hideStatus();
        showStatus('Connected to Xverse!', 'success');
        setTimeout(hideStatus, 2000);
        
        updateUI();
        await Promise.all([fetchBalances(), fetchReserves()]);
        return;
      }
    }
    
    throw new Error('No Stacks address found in Xverse wallet');
    
  } catch (error) {
    console.error('Xverse connection error:', error);
    throw error;
  }
}

/**
 * Execute contract call with Xverse
 */
async function executeWithXverse(swapParams) {
  const { functionName, amountIn, minAmountOut, deadline, inputToken, outputToken } = swapParams;
  const provider = window.XverseProviders?.StacksProvider;
  
  if (!provider) {
    throw new Error('Xverse provider not available');
  }
  
  const response = await provider.request('stx_callContract', {
    contract: `${CONFIG.poolContract.address}.${CONFIG.poolContract.name}`,
    functionName: functionName,
    functionArgs: [
      { type: 'uint128', value: amountIn.toString() },
      { type: 'uint128', value: minAmountOut.toString() },
      { type: 'uint128', value: deadline.toString() },
      { type: 'principal', value: `${inputToken.address}.${inputToken.name}` },
      { type: 'principal', value: `${outputToken.address}.${outputToken.name}` }
    ],
    network: CONFIG.network,
    postConditionMode: 'deny',
    postConditions: [
      {
        type: 'ft-postcondition',
        address: state.address,
        conditionCode: 'eq',
        amount: amountIn.toString(),
        asset: `${inputToken.address}.${inputToken.name}::${inputToken.assetName}`
      }
    ]
  });
  
  console.log('Xverse contract call response:', response);
  
  if (response.result) {
    return response.result.txid || response.result.txId;
  }
  
  throw new Error('Contract call failed');
}

/**
 * Sign transaction with Xverse (fallback)
 */
async function signWithXverse(unsignedTx) {
  const provider = window.XverseProviders?.StacksProvider;
  const serializedTx = bytesToHex(unsignedTx.serialize());
  
  const response = await provider.request('stx_signTransaction', {
    transaction: serializedTx,
    network: CONFIG.network
  });
  
  console.log('Xverse sign response:', response);
  
  if (response.result) {
    if (response.result.txId || response.result.txid) {
      return response.result.txId || response.result.txid;
    }
    const signedTxHex = response.result.transaction || response.result;
    const signedTx = deserializeTransaction(hexToBytes(signedTxHex));
    const broadcastResult = await broadcastTransaction(signedTx, stacksNetwork);
    
    if (broadcastResult.error) {
      throw new Error(broadcastResult.reason || 'Broadcast failed');
    }
    return broadcastResult.txid;
  }
  
  throw new Error('Signing failed');
}

// ==============================================================================
// WALLETCONNECT CONNECTION (QR Code / Mobile)
// ==============================================================================

async function initializeWalletConnect() {
  if (universalProvider) return;
  
  try {
    console.log('Initializing WalletConnect...');
    
    universalProvider = await UniversalProvider.init({
      projectId: CONFIG.projectId,
      metadata: CONFIG.metadata,
      relayUrl: 'wss://relay.walletconnect.com'
    });

    universalProvider.on('display_uri', (uri) => {
      console.log('WalletConnect URI:', uri);
      showQRModal(uri);
    });

    universalProvider.on('session_delete', () => {
      console.log('Session deleted');
      handleDisconnect();
    });

    console.log('WalletConnect initialized');
    
  } catch (error) {
    console.error('WalletConnect init failed:', error);
    throw error;
  }
}

async function connectWithWalletConnect() {
  showStatus('Opening WalletConnect...', 'pending');
  
  try {
    await initializeWalletConnect();
    
    console.log('Connecting via WalletConnect...');
    const session = await universalProvider.connect({
      namespaces: {
        stacks: {
          methods: ['stx_getAddresses', 'stx_signTransaction', 'stx_signMessage'],
          chains: [STACKS_CHAIN_ID],
          events: ['accountsChanged', 'chainChanged']
        }
      }
    });

    closeQRModal();
    
    state.session = session;
    state.provider = universalProvider;
    state.providerType = 'walletconnect';
    
    // Get Stacks address
    const response = await universalProvider.request({
      method: 'stx_getAddresses',
      params: {}
    }, STACKS_CHAIN_ID);

    console.log('stx_getAddresses response:', response);

    if (response && response.addresses) {
      const addressInfo = response.addresses.find(addr => 
        CONFIG.network === 'mainnet' 
          ? addr.address.startsWith('SP') 
          : addr.address.startsWith('ST')
      );
      state.address = addressInfo?.address || response.addresses[0]?.address;
    } else if (typeof response === 'string') {
      state.address = response;
    }

    if (!state.address) {
      throw new Error('No Stacks address returned');
    }

    state.connected = true;
    hideStatus();
    showStatus('Connected via WalletConnect!', 'success');
    setTimeout(hideStatus, 2000);
    
    updateUI();
    await Promise.all([fetchBalances(), fetchReserves()]);

  } catch (error) {
    console.error('WalletConnect connection failed:', error);
    closeQRModal();
    throw error;
  }
}

function showQRModal(uri) {
  let modal = document.getElementById('wc-qr-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'wc-qr-modal';
    modal.className = 'wallet-modal';
    document.body.appendChild(modal);
    
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeQRModal();
    });
  }
  
  modal.innerHTML = `
    <div class="wallet-modal-content">
      <div class="wallet-modal-header">
        <h3>Scan QR Code</h3>
        <button class="wallet-close-btn" onclick="closeQRModal()">&times;</button>
      </div>
      <div class="wallet-modal-body">
        <p class="wallet-subtitle">Scan with your Stacks-compatible mobile wallet</p>
        <div id="wc-qr-container">
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(uri)}" 
               alt="WalletConnect QR" 
               style="border-radius: 12px; background: white; padding: 12px;">
        </div>
        <div class="wc-uri-section">
          <input type="text" id="wc-uri-input" value="${uri}" readonly>
          <button onclick="copyWcUri()">Copy</button>
        </div>
      </div>
    </div>
  `;
  
  modal.style.display = 'flex';
}

function closeQRModal() {
  const modal = document.getElementById('wc-qr-modal');
  if (modal) modal.style.display = 'none';
}

function copyWcUri() {
  const input = document.getElementById('wc-uri-input');
  if (input) {
    navigator.clipboard.writeText(input.value);
    showStatus('Copied!', 'success');
    setTimeout(hideStatus, 2000);
  }
}

window.closeQRModal = closeQRModal;
window.copyWcUri = copyWcUri;

/**
 * Sign transaction with WalletConnect
 */
async function signWithWalletConnect(unsignedTx) {
  const serializedTx = bytesToHex(unsignedTx.serialize());

  const signedTxHex = await universalProvider.request({
    method: 'stx_signTransaction',
    params: {
      transaction: serializedTx,
      network: CONFIG.network,
      address: state.address
    }
  }, STACKS_CHAIN_ID);

  console.log('Signed transaction:', signedTxHex);

  if (typeof signedTxHex === 'object' && signedTxHex.txId) {
    return signedTxHex.txId;
  }

  const signedTx = deserializeTransaction(hexToBytes(signedTxHex));
  const broadcastResult = await broadcastTransaction(signedTx, stacksNetwork);
  
  if (broadcastResult.error) {
    throw new Error(broadcastResult.reason || 'Broadcast failed');
  }

  return broadcastResult.txid;
}

// ==============================================================================
// MAIN CONNECTION HANDLER
// ==============================================================================

async function connectWallet() {
  showWalletModal();
}

async function connectWithWallet(walletId) {
  try {
    switch (walletId) {
      case 'leather':
        await connectWithLeather();
        break;
      case 'xverse':
        await connectWithXverse();
        break;
      case 'walletconnect':
        await connectWithWalletConnect();
        break;
      default:
        throw new Error('Unknown wallet');
    }
  } catch (error) {
    console.error('Connection error:', error);
    showStatus('Connection failed: ' + error.message, 'error');
    setTimeout(hideStatus, 3000);
  }
}

async function disconnectWallet() {
  try {
    if (state.providerType === 'walletconnect' && universalProvider && state.session) {
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
  state.provider = null;
  state.providerType = null;
  state.balanceX = 0;
  state.balanceY = 0;
  updateUI();
}

// ==============================================================================
// SIGN AND BROADCAST TRANSACTION (Routes to correct provider)
// ==============================================================================

async function signAndBroadcastTransaction(unsignedTx) {
  if (!state.connected || !state.address) {
    throw new Error('Wallet not connected');
  }

  switch (state.providerType) {
    case 'leather':
      return await signWithLeather(unsignedTx);
    case 'xverse':
      return await signWithXverse(unsignedTx);
    case 'walletconnect':
      return await signWithWalletConnect(unsignedTx);
    default:
      throw new Error('No wallet provider available');
  }
}

// ==============================================================================
// DEX CONTRACT INTERACTIONS
// ==============================================================================

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
      const result = parseClarityValue(data.result);
      state.reserveX = result.x || 0;
      state.reserveY = result.y || 0;
      console.log('Reserves:', { x: state.reserveX, y: state.reserveY });
    }
  } catch (error) {
    console.error('Failed to fetch reserves:', error);
  }
  
  updateSwapDetails();
}

async function fetchBalances() {
  if (!state.address) return;

  try {
    const apiUrl = CONFIG.network === 'mainnet'
      ? 'https://api.mainnet.hiro.so'
      : 'https://api.testnet.hiro.so';

    // Fetch both token balances
    const balanceUrl = `${apiUrl}/extended/v1/address/${state.address}/balances`;
    const response = await fetch(balanceUrl);
    const data = await response.json();

    // Parse fungible token balances
    if (data.fungible_tokens) {
      // Token X (ALEX)
      const tokenXKey = `${CONFIG.tokenX.address}.${CONFIG.tokenX.name}::${CONFIG.tokenX.assetName}`;
      state.balanceX = parseInt(data.fungible_tokens[tokenXKey]?.balance || '0');

      // Token Y (USDA)
      const tokenYKey = `${CONFIG.tokenY.address}.${CONFIG.tokenY.name}::${CONFIG.tokenY.assetName}`;
      state.balanceY = parseInt(data.fungible_tokens[tokenYKey]?.balance || '0');
    }

    console.log('Balances:', { x: state.balanceX, y: state.balanceY });
    updateBalanceDisplay();
  } catch (error) {
    console.error('Failed to fetch balances:', error);
  }
}

function parseClarityValue(hex) {
  // Simplified parser for tuple responses
  try {
    if (hex.startsWith('0x')) hex = hex.slice(2);
    
    // Check if it's a tuple (0x0c prefix)
    if (hex.startsWith('0c')) {
      const result = {};
      let offset = 2;
      const numItems = parseInt(hex.slice(offset, offset + 8), 16);
      offset += 8;
      
      for (let i = 0; i < numItems; i++) {
        // Read key length
        const keyLen = parseInt(hex.slice(offset, offset + 2), 16);
        offset += 2;
        
        // Read key
        const keyBytes = [];
        for (let j = 0; j < keyLen; j++) {
          keyBytes.push(parseInt(hex.slice(offset + j * 2, offset + j * 2 + 2), 16));
        }
        const key = String.fromCharCode(...keyBytes);
        offset += keyLen * 2;
        
        // Read value type
        const valueType = hex.slice(offset, offset + 2);
        offset += 2;
        
        // Read value based on type
        if (valueType === '01') { // uint
          const valueBigInt = BigInt('0x' + hex.slice(offset, offset + 32));
          result[key] = Number(valueBigInt);
          offset += 32;
        }
      }
      
      return result;
    }
    
    return {};
  } catch (e) {
    console.error('Parse error:', e);
    return {};
  }
}

// ==============================================================================
// SWAP CALCULATIONS
// ==============================================================================

function calculateSwapOutput(amountIn, reserveIn, reserveOut) {
  if (reserveIn === 0 || reserveOut === 0 || amountIn === 0) return 0;
  
  // Constant product formula with fee: dy = (dx * y * (10000 - fee)) / (x * 10000 + dx * (10000 - fee))
  const amountInWithFee = BigInt(amountIn) * BigInt(CONFIG.bpsDenom - CONFIG.feeBps);
  const numerator = amountInWithFee * BigInt(reserveOut);
  const denominator = BigInt(reserveIn) * BigInt(CONFIG.bpsDenom) + amountInWithFee;
  
  return Number(numerator / denominator);
}

function calculatePriceImpact(amountIn, reserveIn, reserveOut) {
  if (reserveIn === 0 || reserveOut === 0 || amountIn === 0) return 0;
  
  const spotPrice = reserveOut / reserveIn;
  const outputAmount = calculateSwapOutput(amountIn, reserveIn, reserveOut);
  const executionPrice = outputAmount / amountIn;
  
  return ((spotPrice - executionPrice) / spotPrice) * 100;
}

// ==============================================================================
// UI UPDATES
// ==============================================================================

function updateUI() {
  if (state.connected) {
    elements.connectBtn.classList.add('hidden');
    elements.walletInfo.classList.remove('hidden');
    elements.walletAddress.textContent = truncateAddress(state.address);
    elements.swapBtn.disabled = false;
  } else {
    elements.connectBtn.classList.remove('hidden');
    elements.walletInfo.classList.add('hidden');
    elements.walletAddress.textContent = '';
    elements.swapBtn.disabled = true;
  }
  
  updateBalanceDisplay();
  updateSwapDetails();
  updateTokenDisplay();
}

function updateTokenDisplay() {
  const inputSymbol = state.swapDirection ? CONFIG.tokenX.symbol : CONFIG.tokenY.symbol;
  const outputSymbol = state.swapDirection ? CONFIG.tokenY.symbol : CONFIG.tokenX.symbol;
  
  if (elements.tokenXSymbol) elements.tokenXSymbol.textContent = inputSymbol;
  if (elements.tokenYSymbol) elements.tokenYSymbol.textContent = outputSymbol;
  
  // Update input/output labels
  const inputLabel = document.querySelector('.token-input-container .token-label');
  const outputLabel = document.querySelector('.token-output-container .token-label');
  if (inputLabel) inputLabel.textContent = `From (${inputSymbol})`;
  if (outputLabel) outputLabel.textContent = `To (${outputSymbol})`;
}

function updateBalanceDisplay() {
  const inputBalance = state.swapDirection ? state.balanceX : state.balanceY;
  const outputBalance = state.swapDirection ? state.balanceY : state.balanceX;
  const inputDecimals = state.swapDirection ? CONFIG.tokenX.decimals : CONFIG.tokenY.decimals;
  const outputDecimals = state.swapDirection ? CONFIG.tokenY.decimals : CONFIG.tokenX.decimals;
  const inputSymbol = state.swapDirection ? CONFIG.tokenX.symbol : CONFIG.tokenY.symbol;
  const outputSymbol = state.swapDirection ? CONFIG.tokenY.symbol : CONFIG.tokenX.symbol;
  
  if (elements.balanceX) {
    elements.balanceX.textContent = `Balance: ${formatAmount(inputBalance, inputDecimals)} ${inputSymbol}`;
  }
  if (elements.balanceY) {
    elements.balanceY.textContent = `Balance: ${formatAmount(outputBalance, outputDecimals)} ${outputSymbol}`;
  }
}

function updateSwapDetails() {
  const inputAmount = parseFloat(elements.inputAmount.value) || 0;
  
  // Get correct reserves based on swap direction
  const reserveIn = state.swapDirection ? state.reserveX : state.reserveY;
  const reserveOut = state.swapDirection ? state.reserveY : state.reserveX;
  const inputDecimals = state.swapDirection ? CONFIG.tokenX.decimals : CONFIG.tokenY.decimals;
  const outputDecimals = state.swapDirection ? CONFIG.tokenY.decimals : CONFIG.tokenX.decimals;
  const inputSymbol = state.swapDirection ? CONFIG.tokenX.symbol : CONFIG.tokenY.symbol;
  const outputSymbol = state.swapDirection ? CONFIG.tokenY.symbol : CONFIG.tokenX.symbol;
  
  if (inputAmount > 0 && reserveIn > 0 && reserveOut > 0) {
    const amountIn = parseAmount(inputAmount.toString(), inputDecimals);
    const outputAmount = calculateSwapOutput(amountIn, reserveIn, reserveOut);
    const priceImpact = calculatePriceImpact(amountIn, reserveIn, reserveOut);
    const minReceived = outputAmount * (1 - state.slippage / 100);
    const fee = (inputAmount * CONFIG.feeBps) / CONFIG.bpsDenom;
    
    elements.outputAmount.value = formatAmount(outputAmount, outputDecimals);
    
    if (elements.exchangeRate) {
      const rate = outputAmount / amountIn;
      elements.exchangeRate.textContent = `1 ${inputSymbol} = ${(rate * Math.pow(10, inputDecimals - outputDecimals)).toFixed(6)} ${outputSymbol}`;
    }
    if (elements.dexFee) {
      elements.dexFee.textContent = `${fee.toFixed(6)} ${inputSymbol}`;
    }
    if (elements.minReceived) {
      elements.minReceived.textContent = `${formatAmount(minReceived, outputDecimals)} ${outputSymbol}`;
    }
    if (elements.priceImpact) {
      elements.priceImpact.textContent = `${priceImpact.toFixed(2)}%`;
      elements.priceImpact.className = priceImpact > 5 ? 'warning' : '';
    }
    if (elements.slippageDisplay) {
      elements.slippageDisplay.textContent = `${state.slippage}%`;
    }
    
    elements.swapDetails.classList.remove('hidden');
  } else {
    elements.outputAmount.value = '';
    elements.swapDetails.classList.add('hidden');
  }
}

function switchSwapDirection() {
  state.swapDirection = !state.swapDirection;
  
  // Swap input/output values
  const inputVal = elements.inputAmount.value;
  const outputVal = elements.outputAmount.value;
  elements.inputAmount.value = outputVal;
  elements.outputAmount.value = inputVal;
  
  updateTokenDisplay();
  updateBalanceDisplay();
  updateSwapDetails();
  
  // Animate the button
  if (elements.swapDirectionBtn) {
    elements.swapDirectionBtn.classList.add('rotating');
    setTimeout(() => elements.swapDirectionBtn.classList.remove('rotating'), 300);
  }
}

// ==============================================================================
// SWAP EXECUTION
// ==============================================================================

async function executeSwap() {
  if (!state.connected || !state.address) {
    showStatus('Please connect wallet first', 'error');
    return;
  }

  const inputAmount = parseFloat(elements.inputAmount.value);
  if (!inputAmount || inputAmount <= 0) {
    showStatus('Please enter a valid amount', 'error');
    return;
  }

  // Get reserves based on swap direction
  const reserveIn = state.swapDirection ? state.reserveX : state.reserveY;
  const reserveOut = state.swapDirection ? state.reserveY : state.reserveX;
  const inputDecimals = state.swapDirection ? CONFIG.tokenX.decimals : CONFIG.tokenY.decimals;
  const outputDecimals = state.swapDirection ? CONFIG.tokenY.decimals : CONFIG.tokenX.decimals;
  const inputToken = state.swapDirection ? CONFIG.tokenX : CONFIG.tokenY;
  const outputToken = state.swapDirection ? CONFIG.tokenY : CONFIG.tokenX;
  const functionName = state.swapDirection ? 'swap-x-for-y' : 'swap-y-for-x';

  const amountIn = parseAmount(inputAmount.toString(), inputDecimals);
  const expectedOutput = calculateSwapOutput(amountIn, reserveIn, reserveOut);
  const minAmountOut = Math.floor(expectedOutput * (1 - state.slippage / 100));

  // Calculate deadline
  try {
    const blockResponse = await fetch(
      CONFIG.network === 'mainnet'
        ? 'https://api.mainnet.hiro.so/v2/info'
        : 'https://api.testnet.hiro.so/v2/info'
    );
    const blockInfo = await blockResponse.json();
    state.currentBlockHeight = blockInfo.stacks_tip_height;
  } catch (e) {
    console.error('Failed to fetch block height:', e);
  }
  
  const deadline = state.currentBlockHeight + state.deadlineBlocks;

  showStatus('Preparing swap...', 'pending');

  try {
    // Create swap parameters
    const swapParams = {
      functionName,
      amountIn,
      minAmountOut,
      deadline,
      inputToken,
      outputToken
    };

    showStatus('Please confirm in wallet...', 'pending');

    let txId;
    
    // Route to appropriate execution method based on wallet type
    if (state.providerType === 'leather') {
      // Use Leather's native stx_callContract
      txId = await executeWithLeather(swapParams);
    } else if (state.providerType === 'xverse') {
      // Use Xverse's native method
      txId = await executeWithXverse(swapParams);
    } else {
      // Build transaction for WalletConnect
      const postConditions = [
        makeStandardFungiblePostCondition(
          state.address,
          FungibleConditionCode.Equal,
          amountIn,
          createAssetInfo(inputToken.address, inputToken.name, inputToken.assetName)
        )
      ];

      const txOptions = {
        contractAddress: CONFIG.poolContract.address,
        contractName: CONFIG.poolContract.name,
        functionName: functionName,
        functionArgs: [
          uintCV(amountIn),
          uintCV(minAmountOut),
          uintCV(deadline),
          principalCV(`${inputToken.address}.${inputToken.name}`),
          principalCV(`${outputToken.address}.${outputToken.name}`)
        ],
        network: stacksNetwork,
        postConditionMode: PostConditionMode.Deny,
        postConditions: postConditions,
        anchorMode: AnchorMode.Any,
        fee: 10000
      };

      const unsignedTx = await makeUnsignedContractCall(txOptions);
      txId = await signWithWalletConnect(unsignedTx);
    }

    showStatus(`Swap submitted! TX: ${txId.slice(0, 10)}...`, 'success');
    
    // Open explorer
    const explorerUrl = CONFIG.network === 'mainnet'
      ? `https://explorer.hiro.so/txid/${txId}?chain=mainnet`
      : `https://explorer.hiro.so/txid/${txId}?chain=testnet`;
    window.open(explorerUrl, '_blank');

    // Clear inputs and refresh
    elements.inputAmount.value = '';
    elements.outputAmount.value = '';
    elements.swapDetails.classList.add('hidden');

    setTimeout(async () => {
      await Promise.all([fetchBalances(), fetchReserves()]);
      hideStatus();
    }, 5000);

  } catch (error) {
    console.error('Swap failed:', error);
    showStatus('Swap failed: ' + error.message, 'error');
    setTimeout(hideStatus, 5000);
  }
}

// ==============================================================================
// SETTINGS
// ==============================================================================

function openSettings() {
  elements.settingsModal.classList.remove('hidden');
}

function closeSettings() {
  elements.settingsModal.classList.add('hidden');
}

function setSlippage(value) {
  state.slippage = parseFloat(value);
  elements.slippageBtns.forEach(btn => {
    btn.classList.toggle('active', parseFloat(btn.dataset.value) === state.slippage);
  });
  elements.customSlippage.value = '';
  updateSwapDetails();
}

function setCustomSlippage(value) {
  const slippage = parseFloat(value);
  if (!isNaN(slippage) && slippage >= 0.01 && slippage <= 50) {
    state.slippage = slippage;
    elements.slippageBtns.forEach(btn => btn.classList.remove('active'));
    updateSwapDetails();
  }
}

function setDeadline(value) {
  const blocks = parseInt(value);
  if (!isNaN(blocks) && blocks >= 1 && blocks <= 100) {
    state.deadlineBlocks = blocks;
  }
}

// ==============================================================================
// EVENT LISTENERS
// ==============================================================================

function initEventListeners() {
  // Wallet connection
  elements.connectBtn?.addEventListener('click', connectWallet);
  elements.disconnectBtn?.addEventListener('click', disconnectWallet);
  
  // Swap direction toggle
  elements.swapDirectionBtn?.addEventListener('click', switchSwapDirection);
  
  // Swap inputs
  elements.inputAmount?.addEventListener('input', updateSwapDetails);
  
  // Max button
  elements.maxBtn?.addEventListener('click', () => {
    const maxBalance = state.swapDirection ? state.balanceX : state.balanceY;
    const decimals = state.swapDirection ? CONFIG.tokenX.decimals : CONFIG.tokenY.decimals;
    elements.inputAmount.value = formatAmount(maxBalance, decimals).replace(/,/g, '');
    updateSwapDetails();
  });
  
  // Swap button
  elements.swapBtn?.addEventListener('click', executeSwap);
  
  // Settings
  elements.settingsBtn?.addEventListener('click', openSettings);
  elements.closeSettings?.addEventListener('click', closeSettings);
  
  elements.slippageBtns?.forEach(btn => {
    btn.addEventListener('click', () => setSlippage(btn.dataset.value));
  });
  
  elements.customSlippage?.addEventListener('input', (e) => setCustomSlippage(e.target.value));
  elements.deadlineBlocks?.addEventListener('input', (e) => setDeadline(e.target.value));
  
  // Close settings on backdrop click
  elements.settingsModal?.addEventListener('click', (e) => {
    if (e.target === elements.settingsModal) closeSettings();
  });
  
  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSettings();
      closeWalletModal();
      closeQRModal();
    }
  });
}

// ==============================================================================
// INITIALIZATION
// ==============================================================================

async function init() {
  console.log('Initializing Stacks DEX...');
  console.log('Detected wallets:', detectWallets().map(w => w.name));
  
  initEventListeners();
  updateUI();
  
  // Fetch initial data
  await fetchReserves();
  
  // Check for existing WalletConnect session
  try {
    await initializeWalletConnect();
    if (universalProvider?.session) {
      state.providerType = 'walletconnect';
      state.provider = universalProvider;
      state.session = universalProvider.session;
      
      const response = await universalProvider.request({
        method: 'stx_getAddresses',
        params: {}
      }, STACKS_CHAIN_ID);
      
      if (response?.addresses?.[0]?.address) {
        state.address = response.addresses[0].address;
        state.connected = true;
        updateUI();
        await fetchBalances();
      }
    }
  } catch (e) {
    console.log('No existing session');
  }
  
  console.log('DEX initialized');
}

// Start app
document.addEventListener('DOMContentLoaded', init);
