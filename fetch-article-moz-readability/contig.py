import re
import sys

def parse_unicode_from_filename(filename):
    match = re.search(r'u([0-9a-fA-F]+)', filename)
    if match:
        return int(match.group(1), 16)
    return None

def find_contiguous_ranges(unicode_list):
    sorted_unicode_list = sorted(unicode_list)
    ranges = []
    start = sorted_unicode_list[0]
    end = sorted_unicode_list[0]

    for code in sorted_unicode_list[1:]:
        if code == end + 1:
            end = code
        else:
            ranges.append((start, end))
            start = code
            end = code

    ranges.append((start, end))
    return ranges

def main():
    filenames = [line.strip() for line in sys.stdin]

    unicode_list = [parse_unicode_from_filename(filename) for filename in filenames if parse_unicode_from_filename(filename) is not None]
    ranges = find_contiguous_ranges(unicode_list)

    for r in ranges:
        if r[0] == r[1]:
            print(f'U+{r[0]:04X}')
        else:
            print(f'U+{r[0]:04X}-U+{r[1]:04X}')

if __name__ == "__main__":
    main()

