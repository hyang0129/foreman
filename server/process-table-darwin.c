// macOS process birth identities survive reparenting and PID reuse. Layouts:
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h
// This helper reads process metadata only; --exec gates provider startup until
// the watchdog has recorded its identity. It never interprets shell commands.
#include <libproc.h>
#include <sys/proc_info.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>

struct unique_info {
    uint8_t uuid[16];
    uint64_t identity, parent_identity;
    int32_t version, original_parent_version;
    uint64_t reserved[2];
};
struct bsd_unique_info { struct proc_bsdinfo bsd; struct unique_info unique; };
_Static_assert(sizeof(struct unique_info) == 56, "macOS process identity ABI");

int main(int argc, char **argv) {
    if (argc >= 3 && strcmp(argv[1], "--exec") == 0) {
        char ready;
        if (read(3, &ready, 1) != 1 || ready != '1') return 2;
        close(3);
        execvp(argv[2], argv + 2);
        perror("Provider exec failed");
        return 2;
    }
    // Fail explicitly if this macOS release no longer supports the identity ABI.
    struct bsd_unique_info self;
    if (proc_pidinfo(getpid(), 18, 0, &self, sizeof(self)) != sizeof(self)) return 1;
    int size = proc_listpids(PROC_UID_ONLY, getuid(), NULL, 0) * 2 + 4096;
    pid_t *pids = malloc(size);
    if (!pids) return 1;
    int bytes = proc_listpids(PROC_UID_ONLY, getuid(), pids, size);
    if (bytes <= 0 || bytes >= size) { free(pids); return 1; }
    for (int i = 0; i < bytes / sizeof(pid_t); i++) {
        struct bsd_unique_info info;
        if (pids[i] <= 0 || proc_pidinfo(pids[i], 18, 0, &info, sizeof(info)) != sizeof(info)) continue;
        printf("%u %u %u %c %llu %llu\n", info.bsd.pbi_pid, info.bsd.pbi_ppid,
            info.bsd.pbi_pgid, info.bsd.pbi_status == 5 ? 'Z' : 'S',
            (unsigned long long)info.unique.identity, (unsigned long long)info.unique.parent_identity);
    }
    free(pids);
    return 0;
}
