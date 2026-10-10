"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCustomModelHandlers = registerCustomModelHandlers;
/** Addon-owned channels only; vendor desktop APIs are left intact. */
const electron_1 = require("electron");
const path = __importStar(require("node:path"));
const cryptoStore = __importStar(require("./cryptoStore"));
const modelManagement_1 = require("./modelManagement");
function registerCustomModelHandlers() {
    const manager = (0, modelManagement_1.createModelManager)(path.join(electron_1.app.getPath('home'), '.gemini', 'antigravity'), cryptoStore, (url) => electron_1.shell.openExternal(url));
    const handle = (channel, action) => {
        electron_1.ipcMain.handle(channel, async (_event, ...args) => {
            try {
                return await action(...args);
            }
            catch (error) {
                if (channel === 'storage:get-custom-models' || channel === 'storage:export-custom-models')
                    throw error;
                const status = error.status;
                return { success: false, error: error.message, ...(status ? { status } : {}) };
            }
        });
    };
    handle('storage:get-custom-models', () => manager.store.list());
    handle('storage:save-custom-model', manager.saveModel);
    handle('storage:delete-custom-model', (name) => {
        manager.store.delete(name);
        return { success: true };
    });
    handle('storage:test-model-connection', (model) => manager.testModel(model));
    handle('storage:get-provider-presets', manager.presets);
    handle('storage:discover-models', manager.discoverModels);
    handle('storage:discover-local', manager.discoverLocal);
    handle('storage:export-custom-models', () => manager.store.export());
    handle('storage:import-custom-models', (payload) => ({ success: true, count: manager.store.import(payload) }));
    handle('storage:get-gateway', manager.getGateway);
    handle('storage:save-gateway', manager.saveGateway);
    handle('storage:test-gateway', manager.testGateway);
    handle('storage:import-gateway-models', manager.importGatewayModels);
    handle('storage:open-gateway-dashboard', manager.openDashboard);
    handle('storage:google-login', manager.googleLogin);
    handle('storage:google-login-cancel', manager.googleLoginCancel);
    handle('storage:google-test-account', manager.googleTestAccount);
    handle('storage:google-pool-status', manager.googlePoolStatus);
}
//# sourceMappingURL=customIpc.js.map