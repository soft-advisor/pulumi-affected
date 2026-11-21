#!/bin/sh
# Stands in for a wrapper script that prints before running Pulumi, e.g. while assuming a role
if [ -n "$BANNER" ]; then echo "$BANNER"; fi
exec pulumi "$@"
