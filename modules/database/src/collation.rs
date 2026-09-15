use std::cmp::Ordering;

use pinyin::ToPinyin;

/// Convert a string to its pinyin representation for comparison.
/// Chinese characters become their pinyin reading; non-Chinese characters pass through unchanged.
fn to_pinyin_for_cmp(s: &str) -> String {
    let mut result = String::with_capacity(s.len() * 6);
    for (ch, py) in s.chars().zip(s.to_pinyin()) {
        match py {
            Some(p) => result.push_str(p.plain()),
            None => result.push(ch),
        }
    }
    result
}

/// Compare two strings by their pinyin representation.
pub fn compare_pinyin(a: &str, b: &str) -> Ordering {
    to_pinyin_for_cmp(a).cmp(&to_pinyin_for_cmp(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn han_characters_are_transliterated() {
        assert_eq!(to_pinyin_for_cmp("张"), "zhang");
        assert_eq!(to_pinyin_for_cmp("李四"), "lisi");
        // Non-Chinese characters keep their place in the string.
        assert_eq!(to_pinyin_for_cmp("a张b"), "azhangb");
        assert_eq!(to_pinyin_for_cmp("hello"), "hello");
        assert_eq!(to_pinyin_for_cmp(""), "");
    }

    #[test]
    fn identical_strings_are_equal() {
        assert_eq!(compare_pinyin("", ""), Ordering::Equal);
        assert_eq!(compare_pinyin("apple", "apple"), Ordering::Equal);
        assert_eq!(compare_pinyin("张三", "张三"), Ordering::Equal);
    }

    #[test]
    fn han_characters_sort_by_pinyin_not_codepoint() {
        // 李 (li) precedes 张 (zhang) in pinyin, but 张 has the lower codepoint.
        assert_eq!(compare_pinyin("李", "张"), Ordering::Less);
        assert_eq!(compare_pinyin("张", "李"), Ordering::Greater);

        assert_eq!(compare_pinyin("阿", "波"), Ordering::Less);
        assert_eq!(compare_pinyin("波", "张"), Ordering::Less);
    }

    #[test]
    fn ascii_passes_through_unchanged() {
        assert_eq!(compare_pinyin("apple", "banana"), Ordering::Less);
        assert_eq!(compare_pinyin("banana", "apple"), Ordering::Greater);
        // Byte-ish ordering: uppercase sorts before lowercase.
        assert_eq!(compare_pinyin("Apple", "apple"), Ordering::Less);
        assert_eq!(compare_pinyin("a1", "ab"), Ordering::Less);
    }

    #[test]
    fn a_prefix_sorts_first() {
        assert_eq!(compare_pinyin("li", "lisi"), Ordering::Less);
        assert_eq!(compare_pinyin("李", "李四"), Ordering::Less);
        assert_eq!(compare_pinyin("z", "zhang"), Ordering::Less);
    }

    #[test]
    fn mixed_scripts_are_compared_by_their_transliteration() {
        // "a" < "b", so the Han word for "b" sorts last.
        assert_eq!(compare_pinyin("阿", "b"), Ordering::Less);
        assert_eq!(compare_pinyin("b", "阿"), Ordering::Greater);
    }

    #[test]
    fn ordering_is_consistent() {
        let mut names = vec!["张", "李", "阿", "波"];
        names.sort_by(|a, b| compare_pinyin(a, b));

        assert_eq!(names, vec!["阿", "波", "李", "张"]);
    }
}
