import com.intellij.openapi.application.ApplicationManager;
import com.yg.dsh.idea.bridge.BridgeSettings;
import com.yg.dsh.idea.bridge.IdeaBridge;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * Verification aid (not production code): drives the REAL compiled
 * `IdeaBridge.send` outside an IDE by installing a proxied
 * `com.intellij.openapi.application.Application` whose `getService()` returns a
 * plain `BridgeSettings` instance. That is the only platform dependency on the
 * send path, so the success and failure branches can be exercised for real.
 *
 * Usage: java ... IdeaBridgeProbe <mode> [inboxDirOverride]
 *   mode = writable | unwritable | handshake | resolve | home | badoverride[-send]
 *   "resolve" prints the directory resolution only and writes nothing.
 */
public final class IdeaBridgeProbe {
    public static void main(String[] args) throws Exception {
        String mode = args[0];
        String override = args.length > 1 ? args[1] : "";
        BridgeSettings settings = new BridgeSettings();
        settings.setInboxDirOverride(override);

        InvocationHandler handler = (proxy, method, methodArgs) -> {
            switch (method.getName()) {
                case "getService":
                    if (methodArgs != null && methodArgs.length == 1 && methodArgs[0] == BridgeSettings.class) {
                        return settings;
                    }
                    return null;
                case "toString":
                    return "probe-application";
                case "hashCode":
                    return System.identityHashCode(proxy);
                case "equals":
                    return proxy == methodArgs[0];
                default:
                    return defaultValue(method.getReturnType());
            }
        };
        Object application = Proxy.newProxyInstance(
                IdeaBridgeProbe.class.getClassLoader(),
                new Class<?>[]{com.intellij.openapi.application.Application.class},
                handler);
        ApplicationManager.setApplication((com.intellij.openapi.application.Application) application);

        IdeaBridge.Selection selection = new IdeaBridge.Selection(
                System.getenv("PROBE_PROJECT"),
                System.getenv("PROBE_FILE"),
                "kotlin",
                10,
                20,
                "@" + System.getenv("PROBE_FILE") + "#L10-20 ");

        System.out.println("mode=" + mode);
        if (mode.equals("badoverride") || mode.equals("badoverride-send")) {
            // A settings value that is not a valid path used to make
            // resolveInboxDir() throw out of send() (verification defect D3).
            settings.setInboxDirOverride("bad\u0000override");
            try {
                System.out.println("resolveInboxDir=" + IdeaBridge.INSTANCE.resolveInboxDir());
            } catch (Throwable t) {
                System.out.println("resolveInboxDir THREW=" + t.getClass().getName() + ": " + t.getMessage());
            }
            if (mode.equals("badoverride-send")) {
                try {
                    IdeaBridge.Result bad = IdeaBridge.INSTANCE.send(selection, true);
                    System.out.println("send returned ok=" + bad.getOk() + " error=" + bad.getError());
                } catch (Throwable t) {
                    System.out.println("send THREW=" + t.getClass().getName() + ": " + t.getMessage());
                }
            }
            return;
        }
        if (mode.equals("home")) {
            System.out.println("defaultDshHome=" + IdeaBridge.INSTANCE.defaultDshHome());
            return;
        }
        if (mode.equals("resolve")) {
            System.out.println("resolvedInboxDir=" + IdeaBridge.INSTANCE.resolveInboxDir());
            System.out.println("isBridgeDetected=" + IdeaBridge.INSTANCE.isBridgeDetected());
            return;
        }
        System.out.println("override=" + (override.isEmpty() ? "(none)" : override));
        System.out.println("DSH_HOME=" + System.getenv("DSH_HOME"));
        try {
            IdeaBridge.Result result = IdeaBridge.INSTANCE.send(selection, true);
            System.out.println("ok=" + result.getOk());
            System.out.println("inboxDir=" + result.getInboxDir());
            System.out.println("bridgeDetected=" + result.getBridgeDetected());
            System.out.println("error=" + result.getError());
            Path inbox = result.getInboxDir();
            if (inbox != null && Files.isDirectory(inbox)) {
                try (var stream = Files.newDirectoryStream(inbox)) {
                    for (Path p : stream) {
                        System.out.println("leftover=" + p.getFileName() + " mode="
                                + java.nio.file.attribute.PosixFilePermissions.toString(Files.getPosixFilePermissions(p)));
                    }
                } catch (Exception e) {
                    System.out.println("leftover=<unreadable: " + e.getClass().getSimpleName() + ">");
                }
            }
        } catch (Throwable t) {
            System.out.println("THREW=" + t.getClass().getName() + ": " + t.getMessage());
        }
    }

    private static Object defaultValue(Class<?> type) {
        if (!type.isPrimitive()) return null;
        if (type == boolean.class) return false;
        if (type == char.class) return (char) 0;
        if (type == byte.class) return (byte) 0;
        if (type == short.class) return (short) 0;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        if (type == float.class) return 0f;
        if (type == double.class) return 0d;
        return null;
    }
}
