import { parseAbi, parseAbiParameters } from 'viem';
export const ROUTE_ABI = parseAbi([
  'function peers(uint32 eid) view returns (bytes32)',
  'function eid() view returns (uint32)',
  'function getSendLibrary(address sender,uint32 dstEid) view returns (address)',
  'function isDefaultSendLibrary(address sender,uint32 dstEid) view returns (bool)',
  'function getReceiveLibrary(address receiver,uint32 srcEid) view returns (address lib,bool isDefault)',
  'function isRegisteredLibrary(address lib) view returns (bool)',
  'function isSupportedEid(uint32 eid) view returns (bool)',
  'function version() view returns (uint64 major,uint8 minor,uint8 endpointVersion)',
  'function getConfig(address oapp,address lib,uint32 eid,uint32 configType) view returns (bytes)',
  'function enforcedOptions(uint32 eid,uint16 msgType) view returns (bytes)',
  'function paused() view returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  // The first four words are common to the legacy 4-word and current 5-word Executor layouts.
  'function dstConfig(uint32 eid) view returns (uint64 baseGas,uint16 multiplierBps,uint128 floorMarginUSD,uint128 nativeCap)',
]);
export const ULN_CONFIG_ABI = parseAbiParameters('(uint64 confirmations,uint8 requiredDVNCount,uint8 optionalDVNCount,uint8 optionalDVNThreshold,address[] requiredDVNs,address[] optionalDVNs)');
export const EXECUTOR_CONFIG_ABI = parseAbiParameters('(uint32 maxMessageSize,address executor)');
