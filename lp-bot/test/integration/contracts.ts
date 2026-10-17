/** Test-only contracts, compiled at test time with solc-js (no network needed). */
import solc from "solc";

const SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract WETH9 {
    string public name = "Wrapped Ether";
    string public symbol = "WETH";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    receive() external payable { deposit(); }
    function deposit() public payable { balanceOf[msg.sender] += msg.value; emit Transfer(address(0), msg.sender, msg.value); }
    function withdraw(uint256 wad) public {
        require(balanceOf[msg.sender] >= wad, "WETH: balance");
        balanceOf[msg.sender] -= wad;
        (bool ok, ) = msg.sender.call{value: wad}("");
        require(ok, "WETH: send");
        emit Transfer(msg.sender, address(0), wad);
    }
    function totalSupply() public view returns (uint256) { return address(this).balance; }
    function approve(address guy, uint256 wad) public returns (bool) { allowance[msg.sender][guy] = wad; emit Approval(msg.sender, guy, wad); return true; }
    function transfer(address dst, uint256 wad) public returns (bool) { return transferFrom(msg.sender, dst, wad); }
    function transferFrom(address src, address dst, uint256 wad) public returns (bool) {
        require(balanceOf[src] >= wad, "WETH: balance");
        if (src != msg.sender && allowance[src][msg.sender] != type(uint256).max) {
            require(allowance[src][msg.sender] >= wad, "WETH: allowance");
            allowance[src][msg.sender] -= wad;
        }
        balanceOf[src] -= wad;
        balanceOf[dst] += wad;
        emit Transfer(src, dst, wad);
        return true;
    }
}

contract TestToken {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    constructor(string memory n, string memory s, uint8 d, uint256 supply) {
        name = n; symbol = s; decimals = d; totalSupply = supply; balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }
    function approve(address sp, uint256 v) external returns (bool) { allowance[msg.sender][sp] = v; emit Approval(msg.sender, sp, v); return true; }
    function transfer(address to, uint256 v) external returns (bool) { _move(msg.sender, to, v); return true; }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) { require(allowance[f][msg.sender] >= v, "allowance"); allowance[f][msg.sender] -= v; }
        _move(f, to, v); return true;
    }
    function _move(address f, address to, uint256 v) internal { require(balanceOf[f] >= v, "balance"); balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v); }
}
`;

export function compileTestContracts(): Record<"WETH9" | "TestToken", { abi: any[]; bytecode: string }> {
  const input = {
    language: "Solidity",
    sources: { "T.sol": { content: SOURCE } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors ?? []).filter((e: any) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e: any) => e.formattedMessage).join("\n"));
  const get = (n: string) => ({ abi: out.contracts["T.sol"][n].abi, bytecode: "0x" + out.contracts["T.sol"][n].evm.bytecode.object });
  return { WETH9: get("WETH9"), TestToken: get("TestToken") };
}
