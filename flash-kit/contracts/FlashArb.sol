// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Flash-loan arbitrage between two Uniswap v3-style pools, profit-or-revert.
///
/// Borrow `amount` of `loanToken` from Morpho Blue (no fee), swap it into `midToken` on
/// `buyRouter`/`buyFee`, swap all of that back on `sellRouter`/`sellFee`, repay, and revert
/// unless at least `minProfit` is left. Every safety property is enforced on-chain:
///   - only the owner can start a route; profit goes to the owner
///   - the callback only runs for Morpho, only during our own call, only for the exact route
///     we started (hash-bound), so nobody can make this contract trade or pay them
///   - routers must be allowlisted by the owner; approvals are exact and reset to zero
///   - nothing is left behind: no mid token, no allowance

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

interface IMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

/// SwapRouter02 (IV3SwapRouter): no deadline field; we check the deadline ourselves.
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

contract FlashArb {
    struct Route {
        address loanToken;
        uint256 amount;
        address midToken;
        address buyRouter;
        uint24 buyFee;
        address sellRouter;
        uint24 sellFee;
        uint256 minMidOut;
        uint256 minProfit;
        uint256 deadline;
    }

    address public immutable owner;
    IMorpho public immutable morpho;
    mapping(address => bool) public routerAllowed;

    bytes32 private activeRoute; // non-zero only while our own flash loan is running

    event RouterSet(address router, bool allowed);
    event Arbitrage(address indexed loanToken, address indexed midToken, uint256 amount, uint256 profit);

    error NotOwner();
    error NotMorpho();
    error NoActiveRoute();
    error RouterNotAllowed(address router);
    error Expired();
    error NoProfit(uint256 got, uint256 wanted);
    error Busy();

    constructor(address morpho_, address[] memory routers) {
        owner = msg.sender;
        morpho = IMorpho(morpho_);
        for (uint256 i = 0; i < routers.length; i++) {
            routerAllowed[routers[i]] = true;
            emit RouterSet(routers[i], true);
        }
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setRouter(address router, bool allowed) external onlyOwner {
        routerAllowed[router] = allowed;
        emit RouterSet(router, allowed);
    }

    /// Run one route. Reverts (costing only gas) unless the loan token balance grows by minProfit.
    function execute(Route calldata r) external onlyOwner returns (uint256 profit) {
        if (activeRoute != bytes32(0)) revert Busy();
        if (block.timestamp > r.deadline) revert Expired();
        if (!routerAllowed[r.buyRouter]) revert RouterNotAllowed(r.buyRouter);
        if (!routerAllowed[r.sellRouter]) revert RouterNotAllowed(r.sellRouter);

        bytes memory data = abi.encode(r);
        uint256 before = IERC20(r.loanToken).balanceOf(address(this));
        activeRoute = keccak256(data);
        morpho.flashLoan(r.loanToken, r.amount, data);
        activeRoute = bytes32(0);

        uint256 afterBal = IERC20(r.loanToken).balanceOf(address(this));
        if (afterBal < before + r.minProfit) revert NoProfit(afterBal > before ? afterBal - before : 0, r.minProfit);
        profit = afterBal - before;
        if (profit > 0) _safeTransfer(r.loanToken, owner, profit);
        emit Arbitrage(r.loanToken, r.midToken, r.amount, profit);
    }

    /// Morpho Blue calls this after sending `assets`; it pulls them back right after we return.
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != address(morpho)) revert NotMorpho();
        if (activeRoute == bytes32(0) || keccak256(data) != activeRoute) revert NoActiveRoute();
        Route memory r = abi.decode(data, (Route));

        uint256 mid = _swap(r.buyRouter, r.loanToken, r.midToken, r.buyFee, assets, r.minMidOut);
        // the sell leg must at least repay the loan, or the whole route reverts here
        _swap(r.sellRouter, r.midToken, r.loanToken, r.sellFee, mid, assets);

        _safeApprove(r.loanToken, address(morpho), assets); // repayment, exact
    }

    function _swap(address router, address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minOut) private returns (uint256 out) {
        _safeApprove(tokenIn, router, amountIn);
        out = ISwapRouter02(router).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        _safeApprove(tokenIn, router, 0);
    }

    /// Recover tokens or ETH sent here by mistake.
    function rescue(address token, uint256 amount) external onlyOwner {
        if (activeRoute != bytes32(0)) revert Busy();
        if (token == address(0)) {
            (bool ok, ) = owner.call{value: amount}("");
            require(ok, "eth send");
        } else {
            _safeTransfer(token, owner, amount);
        }
    }

    // tokens like USDT return nothing from approve/transfer: accept empty return data
    function _safeApprove(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "approve failed");
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer failed");
    }
}
