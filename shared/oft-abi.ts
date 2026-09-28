import { parseAbi } from 'viem';

// LayerZero IOFT: https://github.com/LayerZero-Labs/devtools/blob/main/packages/oft-evm/contracts/interfaces/IOFT.sol
export const OFT_READ_ABI = parseAbi([
  'function token() view returns (address)',
  'function endpoint() view returns (address)',
  'function oftVersion() view returns (bytes4 interfaceId, uint64 version)',
  'function sharedDecimals() view returns (uint8)',
  'function approvalRequired() view returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function stargateType() view returns (uint8)',
]);
export type GetterName = (typeof OFT_READ_ABI)[number]['name'];
export const OFT_SEND_ABI = parseAbi([
  'function send((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) _sendParam, (uint256 nativeFee, uint256 lzTokenFee) _fee, address _refundAddress) payable returns ((bytes32 guid, uint64 nonce, (uint256 nativeFee, uint256 lzTokenFee) fee) msgReceipt, (uint256 amountSentLD, uint256 amountReceivedLD) oftReceipt)',
  'event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)',
]);
export const OFT_QUOTE_ABI = parseAbi([
  'function quoteOFT((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) _sendParam) view returns ((uint256 minAmountLD, uint256 maxAmountLD) limit, (int256 feeAmountLD, string description)[] oftFeeDetails, (uint256 amountSentLD, uint256 amountReceivedLD) receipt)',
  'function quoteSend((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) _sendParam, bool _payInLzToken) view returns ((uint256 nativeFee, uint256 lzTokenFee) fee)',
  'function decimalConversionRate() view returns (uint256)',
  'function combineOptions(uint32 _eid, uint16 _msgType, bytes _extraOptions) view returns (bytes)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
export const OFT_ERROR_ABI = parseAbi([
  'error SlippageExceeded(uint256 amountLD, uint256 minAmountLD)',
  'error AmountSDOverflowed(uint256 amountSD)',
  'error NotEnoughNative(uint256 msgValue)',
  'error NoPeer(uint32 eid)',
  'error InvalidOptions(bytes options)',
  'error EnforcedPause()',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error LZ_InsufficientFee(uint256 requiredNative, uint256 suppliedNative, uint256 requiredLzToken, uint256 suppliedLzToken)',
]);
export const OFT_RECEIVE_ABI = parseAbi([
  'event OFTReceived(bytes32 indexed guid, uint32 srcEid, address indexed toAddress, uint256 amountReceivedLD)',
  'event PacketDelivered((uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
