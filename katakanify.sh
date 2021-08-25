#!/bin/bash -x

echo $1 | mecab -d /var/lib/mecab/dic/ipadic-utf8
