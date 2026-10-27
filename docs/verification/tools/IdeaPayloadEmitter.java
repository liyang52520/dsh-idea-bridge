import com.yg.dsh.idea.bridge.IdeaBridge;
import com.yg.dsh.idea.bridge.SelectionPayload;
import com.yg.dsh.idea.bridge.SelectionText;

/**
 * Verification aid (not production code): calls the REAL compiled Kotlin
 * objects (`SelectionText.format` + `SelectionPayload.json`) so the JSON used
 * by the end-to-end harness is byte-for-byte what the IDE plugin writes,
 * instead of a hand-copied replica.
 *
 * Usage:
 *   java -cp <classes>:<kotlin-stdlib> IdeaPayloadEmitter \
 *        <id> <createdAt> <projectPath|-> <filePath> <language|-> <lineStart> <lineEnd> <submit>
 * Prints the message file content on stdout.
 */
public final class IdeaPayloadEmitter {
    public static void main(String[] args) {
        if (args.length != 8) {
            System.err.println("usage: IdeaPayloadEmitter <id> <createdAt> <projectPath|-> <filePath> <language|-> <lineStart> <lineEnd> <submit>");
            System.exit(2);
        }
        String id = args[0];
        long createdAt = Long.parseLong(args[1]);
        String projectPath = "-".equals(args[2]) ? null : args[2];
        String filePath = args[3];
        String language = "-".equals(args[4]) ? null : args[4];
        int lineStart = Integer.parseInt(args[5]);
        int lineEnd = Integer.parseInt(args[6]);
        boolean submit = Boolean.parseBoolean(args[7]);

        String text = SelectionText.INSTANCE.format(filePath, lineStart, lineEnd);
        IdeaBridge.Selection selection =
                new IdeaBridge.Selection(projectPath, filePath, language, lineStart, lineEnd, text);
        System.out.println(SelectionPayload.INSTANCE.json(id, createdAt, submit, selection));
    }
}
