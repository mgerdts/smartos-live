#!/opt/local/bin/nawk -f

#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2019, Joyent, Inc.
#

#
# This nawk script is used to generate SmartOS 'manifest' files from
# IPS package manifests. This is pretty basic, and doesn't match the
# significant infrastructure that the IPS tooling allows (pkgmogrify transforms,
# dependency generation, include directives, etc.) but we don't have that
# available when building SmartOS, so we make do.
# There is limited support here for the pkgmogrify that are commonly found in
# IPS manifests.
#

#
# Define a series of global variables.
#
BEGIN {
    action_name = "";

    # attrs are the attributes for a given action, set a dummy entry for 'path'
    # here as a canary
    attrs["path"] = "tweet tweet";

    # the full text of the action, built up over continuation lines if needed
    action = "";

    # A state flag, '1' if we're processing a continuation line, i.e. the
    # preceding line ended with a '\' character. Set to '0' otherwise.
    continuation = 0;

    # defaults if specific attributes are not set. pkgmogrify transforms
    # in usr/src/pkg/defaults will do a much better job here unfortunately.
    default_mode = "0555";
    default_owner = "root";
    default_group = "sys";

    # A dictionary of the pkgmogrify macros commonly used by Illumos IPS
    # manifests. This is *not* exhaustive.
    macros["ARCH"] = "i386";
    macros["ARCH32"] = "i86";
    macros["ARCH64"] = "amd64";
    macros["i386_ONLY"] = "";

    # set to '1' to enable debug messages.
    debug_mode = 0;

    # the set of actions we ignore. Leading and trailing spaces are significant
    # as we search for ' <string> ' to cope with substrings, eg. link hardlink
    ignored_actions = " set license device ";
}

function debug(text) {
    if (debug_mode == 1) {
        print " ==== " text;
    }
}

function replace_macros(string) {
    for (macro in macros) {
        re = "\\$\\(" macro "\\)"
        sub(re, macros[macro], string);
    }
    return string;
}

#
# Break our action into an associative array, attrs.
#
function parse_action() {
    if (length(action) == 0) {
        debug("attempted to parse empty action!");
        return;
    }
    split(action, pairs);
    for (i=1; i<= length(pairs); i++) {
        split(pairs[i], keyval, "=");
        attrs[keyval[1]] = keyval[2];
    }
}

#
# Write a line of the output manifest.
#
function emit_line() {
    if (length(action) == 0) {
        return;
    }
    # treat hardlinks just like files. For manifest generation, they're the same
    if (action_name == "file" || action_name == "hardlink") {
        name = "f";
        default_mode = "0444";
    } else if (action_name == "dir") {
        name = "d";
        default_mode = "0555";
    } else if (action_name == "link") {
        name = "s";
    }

    if ("owner" in attrs) {
        owner = attrs["owner"]
    } else {
        owner = default_owner;
    }
    if ("group" in attrs) {
        group = attrs["group"]
    } else {
        group = default_group;
    }
    if ("mode" in attrs) {
        mode = attrs["mode"];
    } else {
        mode = default_mode;
    }
    if (action_name == "file" || action_name == "dir" || action_name == "hardlink") {
        print name " " replace_macros(attrs["path"]) " " mode " " owner " " group;
    } else if (action_name == "link") {
        print name " " replace_macros(attrs["path"]) "=" replace_macros(attrs["target"]);
    }
    action = "";
    delete attrs;
    attrs["path"] = "tweet tweet";
}

#
# returns 1 if we should call 'next' to read the next line
# and continue loading this action (when the action line has
# a continuation line) We can't call 'next' directly from
# a function in awk.
#
function parse_or_next() {
    if (match($0, "\\\\$") != 0) {
        continuation = 1;
        sub("\\\\$", "", $0);
        action = $0;
        return 1;
    } else {
        action = $0;
        parse_action();
        emit_line();
        return 0
    }
}

#
# Deal with file actions
#
/^file|^\$\(i386_ONLY\)file/ {
    debug("file action: " $0);
    action = "";
    action_name = "file";
    res = parse_or_next();
    if (res == 1) {
        next;
    }
}

#
# Deal with directory actions
#
/^dir|^\$\(i386_ONLY\)dir/ {
    debug("dir action: " $0);
    action_name = "dir";
    res = parse_or_next();
    if (res == 1) {
        next;
    }
}

#
# Deal with hardlinks
#
/^hardlink|^\$\(i386_ONLY\)hardlink/ {
    debug("hardlink action: " $0);
    action_name = "hardlink";
    res = parse_or_next();
    if (res == 1) {
        next;
    }
}

#
# Deal with symlinks
#
/^link|^\$\(i386_ONLY\)link/ {
    debug("symlink action: " $0);
    action_name = "link";
    res = parse_or_next();
    if (res == 1) {
        next;
    }
}

#
# Deal with comments by just ignoring them
#
/^#/ {
    debug("comment: " $0);
    next;
}

#
# The "match-everything" case. Deal with continuation lines, and log/ignore
# all actions we don't know about.
#
// {
    split($0, words, " ");
    search = " " words[1] " "
    if (match(ignored_actions, search) != 0) {
        debug("ignored action: " $0);
        next;
    }
    if (continuation == 1) {
        cont = $0;
        if (match(cont, "\\\\$") != 0) {
            debug("still in a continuation");

            sub("\\\\$", "", cont);
            debug("cont is: " cont)
            action = action cont;
            debug("action is now: " action)
            next;
        } else {
            debug("ended our continuation")
            continuation = 0;
            action = action cont;
            debug("complete action is: " action)
            parse_action();
            emit_line();
        }
    }
}

END {
    # drain any remaining action we have buffered till now.
    if (continuation == 1) {
        parse_action();
        emit_line();
    }
}
