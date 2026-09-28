// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

// Local-only integration harness, never a production deployment or a LayerZero substitute.
contract M5Token {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public token;
    address public peer;
    uint32 public localEid;
    uint64 public nonce;
    bool public adapter;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD);
    event OFTReceived(bytes32 indexed guid, uint32 srcEid, address indexed toAddress, uint256 amountReceivedLD);
    struct SendParam { uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD; bytes extraOptions; bytes composeMsg; bytes oftCmd; }
    struct Fee { uint256 nativeFee; uint256 lzTokenFee; }
    struct MessageReceipt { bytes32 guid; uint64 nonce; Fee fee; }
    struct OFTReceipt { uint256 amountSentLD; uint256 amountReceivedLD; }
    function setup(address token_, address peer_, uint32 eid_) external { token = token_; peer = peer_; localEid = eid_; adapter = token_ != address(this); }
    function seed(address who, uint256 amount) external { balanceOf[who] = amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; emit Approval(msg.sender, spender, amount); return true; }
    function transfer(address to, uint256 amount) external returns (bool) { require(balanceOf[msg.sender] >= amount, "balance"); balanceOf[msg.sender] -= amount; balanceOf[to] += amount; emit Transfer(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) { require(balanceOf[from] >= amount && allowance[from][msg.sender] >= amount, "allowance/balance"); allowance[from][msg.sender] -= amount; balanceOf[from] -= amount; balanceOf[to] += amount; emit Transfer(from, to, amount); return true; }
    function send(SendParam calldata p, Fee calldata fee, address) external payable returns (MessageReceipt memory, OFTReceipt memory) {
        uint256 amount = p.amountLD / 1e12 * 1e12;
        require(amount > 0 && amount >= p.minAmountLD && msg.value == 1e15 && fee.nativeFee == msg.value && fee.lzTokenFee == 0, "send conditions");
        if (adapter) M5Token(token).transferFrom(msg.sender, address(this), amount);
        else { require(balanceOf[msg.sender] >= amount, "balance"); balanceOf[msg.sender] -= amount; emit Transfer(msg.sender, address(0), amount); }
        bytes32 guid = keccak256(abi.encodePacked(++nonce, localEid, bytes32(uint256(uint160(address(this)))), p.dstEid, bytes32(uint256(uint160(peer)))));
        emit OFTSent(guid, p.dstEid, msg.sender, amount, amount);
        return (MessageReceipt(guid, nonce, fee), OFTReceipt(amount, amount));
    }
    function receiveTest(bytes32 guid, uint32 srcEid, address to, uint256 amount) external {
        if (adapter) M5Token(token).transfer(to, amount);
        else { balanceOf[to] += amount; emit Transfer(address(0), to, amount); }
        emit OFTReceived(guid, srcEid, to, amount);
    }
}
contract M5Endpoint {
    struct Origin { uint32 srcEid; bytes32 sender; uint64 nonce; }
    event PacketDelivered(Origin origin, address receiver);
    function deliver(Origin calldata origin, address receiver, uint32 dstEid, address recipient, uint256 amount) external {
        bytes32 guid = keccak256(abi.encodePacked(origin.nonce, origin.srcEid, origin.sender, dstEid, bytes32(uint256(uint160(receiver)))));
        M5Token(receiver).receiveTest(guid, origin.srcEid, recipient, amount);
        emit PacketDelivered(origin, receiver);
    }
}
