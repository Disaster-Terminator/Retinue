export function hasPermissionBridge(backend) {
    return "listPermissions" in backend && "replyPermission" in backend;
}
//# sourceMappingURL=types.js.map